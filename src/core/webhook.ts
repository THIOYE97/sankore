/**
 * Réception des webhooks — l'endroit où les intégrations se cassent.
 *
 * Le chemin sortant est facile : on appelle, on lit la réponse. Le chemin
 * ENTRANT est celui qui fait mentir la comptabilité, parce qu'il échappe au
 * contrôle de l'application :
 *
 * - **Tout agrégateur réémet.** Il renvoie le même événement jusqu'à recevoir
 *   un 2xx, et parfois après. Une application qui notifie le client à chaque
 *   réception envoie quatre SMS pour un paiement.
 * - **Les événements arrivent en désordre.** Le `succeeded` peut précéder le
 *   `processing` si le premier envoi a échoué et a été réémis plus tard.
 * - **Un événement final retardataire écrase un état final.** C'est la panne la
 *   plus coûteuse : un `failed` arrivé après un `succeeded` et appliqué sans
 *   garde-fou transforme un encaissement réussi en échec dans les livres.
 * - **Le corps brut est la seule chose signée.** Reparser puis re-sérialiser
 *   invalide la signature : `JSON.stringify` ne restitue pas l'ordre des clés.
 *
 * `WebhookInbox` enchaîne les quatre protections dans le bon ordre — signature,
 * doublon, ordre, transition — et rend une décision explicite, y compris le code
 * HTTP à répondre. Ce dernier point n'est pas cosmétique : répondre autre chose
 * que 2xx à un doublon relance la réémission à l'infini.
 */

import { tryTransition, isFinal } from './status.ts';
import type { PaymentStatus } from './status.ts';
import type { PaymentProvider, WebhookEvent } from './provider.ts';
import { safeObserver, type Observation, type Observer } from './observability.ts';
import { PG_PLACEHOLDER, type Placeholder, type SqlRunner } from './sql.ts';

/* ------------------------------------------------------------------ *
 * Journal des événements déjà vus
 * ------------------------------------------------------------------ */

/**
 * Mémoire des événements traités.
 *
 * `remember` doit être ATOMIQUE : deux instances recevant simultanément la même
 * réémission doivent voir l'une `true` et l'autre `false`. Une implémentation
 * naïve en deux temps (lire puis écrire) laisse passer les deux — et les
 * agrégateurs livrent volontiers en parallèle.
 */
export interface WebhookLog {
    /**
     * Mémorise l'événement. Retourne `true` s'il était inconnu (à traiter),
     * `false` s'il a déjà été vu (à ignorer).
     */
    remember(eventId: string, ttlMs: number): Promise<boolean>;
}

/**
 * Journal mémoire — développement et tests UNIQUEMENT.
 *
 * Ne protège qu'un seul processus et perd tout au redémarrage. En production,
 * le journal doit être partagé : une table avec contrainte d'unicité sur
 * l'identifiant d'événement, ou un `SET NX` Redis. Voir `SqlWebhookLog`.
 */
export class MemoryWebhookLog implements WebhookLog {
    private readonly seen = new Map<string, number>();
    private readonly now: () => number;

    constructor(opts: { now?: () => number } = {}) {
        this.now = opts.now ?? Date.now;
    }

    async remember(eventId: string, ttlMs: number): Promise<boolean> {
        const now = this.now();
        // Purge opportuniste : sans elle, un processus de longue durée
        // accumulerait un identifiant par webhook jusqu'à épuiser la mémoire.
        for (const [key, at] of this.seen) {
            if (now - at > ttlMs) this.seen.delete(key);
        }
        if (this.seen.has(eventId)) return false;
        this.seen.set(eventId, now);
        return true;
    }

    size(): number {
        return this.seen.size;
    }
}

/* ------------------------------------------------------------------ *
 * Décision
 * ------------------------------------------------------------------ */

/**
 * Ce qu'il faut faire du webhook reçu — et quoi répondre au fournisseur.
 *
 * `httpStatus` est porté par la décision plutôt que laissé à l'appelant parce
 * que s'y tromper a des conséquences immédiates : un 500 sur un doublon
 * déclenche une réémission en boucle, un 200 sur une signature invalide
 * confirme à un attaquant que son envoi a été accepté.
 */
export type WebhookDecision =
    /** Signature invalide, ou charge que le fournisseur ne sait pas lire. Répondre 401 et NE RIEN modifier. */
    | { decision: 'rejected'; reason: string; httpStatus: 401 }
    /** Événement déjà traité. Répondre 200 pour faire cesser la réémission. */
    | { decision: 'replayed'; event: WebhookEvent; httpStatus: 200 }
    /** Transition non applicable (désordre, état final déjà atteint). Répondre 200. */
    | { decision: 'ignored'; event: WebhookEvent; reason: string; from: PaymentStatus; httpStatus: 200 }
    /** Transition appliquée et persistée. Répondre 200. */
    | { decision: 'applied'; event: WebhookEvent; from: PaymentStatus; to: PaymentStatus; httpStatus: 200 }
    /** Référence inconnue de l'application. Répondre 200 : réémettre n'y changera rien. */
    | { decision: 'unknown_reference'; event: WebhookEvent; httpStatus: 200 };

export interface WebhookInboxOptions {
    /** Le fournisseur qui a émis — c'est lui qui vérifie la signature et normalise. */
    provider: PaymentProvider;
    /**
     * Lit l'état courant de l'opération dans le stockage de l'application.
     * `null` si la référence est inconnue.
     */
    load: (reference: string) => Promise<PaymentStatus | null>;
    /**
     * Persiste le nouvel état. Appelé UNIQUEMENT quand la transition est
     * applicable — jamais sur un doublon, jamais sur un webhook en désordre.
     *
     * C'est ici, et nulle part ailleurs, que l'application déclenche ses effets
     * de bord : notifier le client, libérer la commande, écrire en comptabilité.
     */
    save: (event: WebhookEvent, from: PaymentStatus, to: PaymentStatus) => Promise<void>;
    /** Journal anti-rejeu. Un `MemoryWebhookLog` par défaut — à remplacer en production. */
    log?: WebhookLog;
    /**
     * Durée de mémorisation d'un identifiant d'événement. 7 jours par défaut.
     *
     * Le bon ordre de grandeur est celui de la fenêtre de réémission du
     * fournisseur, pas une heure : certains agrégateurs réessaient pendant
     * plusieurs jours avant d'abandonner.
     */
    ttlMs?: number;
    observer?: Observer;
    now?: () => number;
}

/* ------------------------------------------------------------------ *
 * Boîte de réception
 * ------------------------------------------------------------------ */

export class WebhookInbox {
    private readonly provider: PaymentProvider;
    private readonly load: (reference: string) => Promise<PaymentStatus | null>;
    private readonly save: (event: WebhookEvent, from: PaymentStatus, to: PaymentStatus) => Promise<void>;
    private readonly log: WebhookLog;
    private readonly ttlMs: number;
    private readonly observe: Observer;
    private readonly now: () => number;

    constructor(opts: WebhookInboxOptions) {
        this.provider = opts.provider;
        this.load = opts.load;
        this.save = opts.save;
        this.log = opts.log ?? new MemoryWebhookLog();
        this.ttlMs = opts.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
        this.observe = safeObserver(opts.observer);
        this.now = opts.now ?? Date.now;
    }

    /**
     * Traite un webhook entrant.
     *
     * `rawBody` doit être le corps **brut**, tel qu'il est arrivé sur le fil.
     * Pas un objet déjà parsé : une signature se calcule sur des octets, et
     * `JSON.stringify(JSON.parse(x))` n'est pas `x`. Dans Express, cela veut
     * dire `express.raw()` sur cette route — et non `express.json()`.
     */
    async handle(rawBody: string, headers: Record<string, string>): Promise<WebhookDecision> {
        const event = this.provider.parseWebhook(rawBody, headers);

        if (!event) {
            this.observe({
                kind: 'webhook.rejected',
                at: this.now(),
                provider: this.provider.name,
                detail: { reason: 'signature invalide ou charge illisible' },
            });
            return {
                decision: 'rejected',
                reason: 'signature invalide ou charge illisible',
                httpStatus: 401,
            };
        }

        // Identifiant de dédoublonnage. Celui du fournisseur s'il existe ;
        // sinon l'empreinte du corps brut, qui a la même propriété : deux
        // réémissions du même événement produisent le même octet, donc la même
        // empreinte. Les événements distincts, eux, diffèrent au moins par leur
        // horodatage interne.
        const eventId = event.eventId ?? `${this.provider.name}:sha256:${await fingerprint(rawBody)}`;

        const fresh = await this.log.remember(eventId, this.ttlMs);
        if (!fresh) {
            this.observe({
                kind: 'webhook.replayed',
                at: this.now(),
                provider: this.provider.name,
                reference: event.reference,
                paymentStatus: event.status,
                detail: { eventId },
            });
            return { decision: 'replayed', event, httpStatus: 200 };
        }

        const current = await this.load(event.reference);
        if (current === null) {
            // Référence inconnue : webhook d'un autre environnement, d'un autre
            // marchand, ou opération purgée. On répond 200 — insister ne la
            // fera pas apparaître — mais on le signale, car c'est anormal.
            this.observe({
                kind: 'webhook.ignored',
                at: this.now(),
                provider: this.provider.name,
                reference: event.reference,
                paymentStatus: event.status,
                detail: { eventId, reason: 'référence inconnue de l\'application' },
            });
            return { decision: 'unknown_reference', event, httpStatus: 200 };
        }

        const move = tryTransition(current, event.status);
        if (!move.applied) {
            this.observe({
                kind: 'webhook.ignored',
                at: this.now(),
                provider: this.provider.name,
                reference: event.reference,
                paymentStatus: event.status,
                detail: {
                    eventId,
                    from: current,
                    reason: move.reason,
                    // Un état final déjà atteint est le cas qui MÉRITE une alerte :
                    // le fournisseur contredit ce que l'application a enregistré.
                    finalStateContradicted: isFinal(current) && current !== event.status,
                },
            });
            return {
                decision: 'ignored',
                event,
                reason: move.reason ?? 'transition non applicable',
                from: current,
                httpStatus: 200,
            };
        }

        await this.save(event, current, move.status);

        const accepted: Observation = {
            kind: 'webhook.accepted',
            at: this.now(),
            provider: this.provider.name,
            reference: event.reference,
            paymentStatus: move.status,
            detail: { eventId, from: current },
        };
        if (event.error) accepted.code = event.error.code;
        this.observe(accepted);

        return { decision: 'applied', event, from: current, to: move.status, httpStatus: 200 };
    }
}

/**
 * Empreinte SHA-256 du corps brut, en hexadécimal.
 *
 * Sert de clé de dédoublonnage quand le fournisseur ne publie pas
 * d'identifiant d'événement. Import dynamique, pour la même raison qu'ailleurs
 * dans le projet : garder les modules du cœur chargeables hors de Node.
 */
async function fingerprint(rawBody: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Journal anti-rejeu adossé à une base SQL.
 *
 * Aucune dépendance : l'appelant fournit la fonction d'exécution de requête de
 * SON pilote (`pg`, `mysql2`, `better-sqlite3`, un pool maison). Sankoré ne
 * choisit pas la base de données de son hôte.
 *
 * La table attendue — l'unicité est portée par la BASE, pas par du code :
 *
 * ```sql
 * CREATE TABLE sankore_webhook_log (
 *   event_id    TEXT PRIMARY KEY,
 *   received_at TIMESTAMPTZ NOT NULL DEFAULT now()
 * );
 * CREATE INDEX ON sankore_webhook_log (received_at);
 * ```
 *
 * C'est la contrainte de clé primaire qui rend `remember` atomique entre tous
 * les processus. Un `SELECT` suivi d'un `INSERT` ne le serait pas : deux
 * instances recevant la même réémission à la même milliseconde passeraient
 * toutes les deux.
 */
export class SqlWebhookLog implements WebhookLog {
    private readonly run: SqlRunner;
    private readonly table: string;
    private readonly ph: Placeholder;
    private readonly now: () => number;

    constructor(opts: {
        run: SqlRunner;
        table?: string;
        /** Dialecte des marqueurs de paramètres. PostgreSQL par défaut. */
        placeholder?: Placeholder;
        now?: () => number;
    }) {
        this.run = opts.run;
        this.table = opts.table ?? 'sankore_webhook_log';
        this.ph = opts.placeholder ?? PG_PLACEHOLDER;
        this.now = opts.now ?? Date.now;
    }

    async remember(eventId: string, ttlMs: number): Promise<boolean> {
        // `ON CONFLICT DO NOTHING` plus comptage des lignes affectées : un seul
        // aller-retour, et c'est la base qui arbitre la course.
        const inserted = await this.run(
            `INSERT INTO ${this.table} (event_id, received_at) VALUES (${this.ph(1)}, ${this.ph(2)}) `
            + 'ON CONFLICT (event_id) DO NOTHING',
            [eventId, new Date(this.now()).toISOString()]
        );
        if (inserted.affected > 0) return true;

        // Déjà présent. Si l'entrée a dépassé sa durée de rétention, c'est que
        // le fournisseur réémet au-delà de sa propre fenêtre : on la rafraîchit
        // et on retraite, plutôt que d'ignorer un événement peut-être légitime.
        const refreshed = await this.run(
            `UPDATE ${this.table} SET received_at = ${this.ph(2)} `
            + `WHERE event_id = ${this.ph(1)} AND received_at < ${this.ph(3)}`,
            [
                eventId,
                new Date(this.now()).toISOString(),
                new Date(this.now() - ttlMs).toISOString(),
            ]
        );
        return refreshed.affected > 0;
    }

    /** Supprime les entrées expirées. À passer en tâche planifiée. */
    async purge(olderThanMs: number): Promise<number> {
        const res = await this.run(
            `DELETE FROM ${this.table} WHERE received_at < ${this.ph(1)}`,
            [new Date(this.now() - olderThanMs).toISOString()]
        );
        return res.affected;
    }
}
