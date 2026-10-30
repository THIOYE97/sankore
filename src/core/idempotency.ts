/**
 * Idempotence — la garantie qu'une même opération ne part jamais deux fois.
 *
 * Scénario réel : le client tape deux fois sur « Envoyer », ou le réseau coupe
 * après l'appel et l'application rejoue. Sans verrou, deux virements partent.
 * En transfert d'argent, c'est la faute la plus coûteuse qui soit.
 *
 * **Trois états, pas deux.** Un verrou d'idempotence naïf n'en connaît que
 * deux — en cours, terminé — et libère la clé dès que l'appel échoue. C'est une
 * faute, et c'est exactement celle que cette bibliothèque existe pour éviter :
 * un `network_timeout` ne dit RIEN de ce qui s'est passé en face. Le virement a
 * pu partir. Libérer la clé autorise un rejeu, et le rejeu paie deux fois.
 *
 * D'où le troisième état, `needs_reconciliation` : la clé reste PRISE, le rejeu
 * est refusé, et l'appelant est explicitement renvoyé vers `fetchStatus()`.
 * C'est moins commode qu'une clé libérée. C'est aussi la seule conduite
 * défendable devant un contrôle de caisse.
 *
 * La clé n'est relâchée que lorsqu'il est CERTAIN que rien n'a été engagé :
 * requête refusée par le fournisseur, erreur de validation, solde insuffisant,
 * service indisponible avant tout traitement.
 *
 * Le store est une interface : en développement, la version mémoire suffit ;
 * en production il faut un verrou partagé entre tous les processus — voir
 * `SqlIdempotencyStore`.
 */

import type { PaymentResult } from './provider.ts';
import { PaymentError } from './errors.ts';
import { safeObserver, type Observer } from './observability.ts';
import { PG_PLACEHOLDER, type Placeholder, type SqlRunner } from './sql.ts';

/* ------------------------------------------------------------------ *
 * Contrat
 * ------------------------------------------------------------------ */

export type IdempotencyState =
    /** Un appel est en cours. Tout rejeu concurrent doit être refusé. */
    | 'in_flight'
    /** Résultat connu et mémorisé. Un rejeu rend ce résultat sans réexécuter. */
    | 'completed'
    /**
     * L'appel a échoué SANS qu'on sache ce qui s'est passé chez le fournisseur.
     * La clé reste prise jusqu'à ce qu'une réconciliation tranche.
     */
    | 'needs_reconciliation';

export interface IdempotencyRecord {
    key: string;
    state: IdempotencyState;
    result?: PaymentResult | undefined;
    /** Erreur ayant mené à `needs_reconciliation`, pour le support. */
    error?: { code: string; message: string; provider?: string } | undefined;
    createdAt: number;
}

export interface IdempotencyStore {
    /**
     * Réserve la clé de façon atomique.
     * Retourne `null` si la réservation réussit (la voie est libre),
     * ou l'enregistrement existant si la clé est déjà prise.
     *
     * **L'atomicité n'est pas négociable.** Un `get` suivi d'un `set` laisse
     * passer deux appels concurrents — précisément le cas que le verrou existe
     * pour fermer. En SQL, c'est un `INSERT … ON CONFLICT DO NOTHING` ; en
     * Redis, un `SET NX`.
     */
    reserve(key: string, ttlMs: number): Promise<IdempotencyRecord | null>;
    /** Mémorise le résultat. Un rejeu ultérieur le rendra sans réexécuter. */
    complete(key: string, result: PaymentResult): Promise<void>;
    /**
     * Marque la clé comme exigeant une réconciliation. La clé reste PRISE :
     * c'est tout l'intérêt.
     */
    markForReconciliation(key: string, error: { code: string; message: string; provider?: string }): Promise<void>;
    /**
     * Libère la clé. À n'appeler que s'il est CERTAIN que rien n'a été engagé
     * côté fournisseur.
     */
    release(key: string): Promise<void>;
    get(key: string): Promise<IdempotencyRecord | null>;
}

/** Un appel est déjà en cours sur cette clé. Ne pas exécuter en parallèle. */
export class DuplicateInFlightError extends Error {
    readonly key: string;
    constructor(key: string) {
        super(`opération déjà en cours pour la clé ${key}`);
        this.name = 'DuplicateInFlightError';
        this.key = key;
    }
}

/**
 * Un appel précédent s'est terminé dans l'incertitude. Rejouer est interdit
 * tant que l'état réel n'a pas été constaté chez le fournisseur.
 *
 * La conduite à tenir est toujours la même : `provider.fetchStatus(reference)`,
 * puis `resolveReconciliation()` avec ce qu'on a constaté. Voir `Reconciler`
 * pour la version automatisée.
 */
export class ReconciliationRequiredError extends Error {
    readonly key: string;
    readonly previous?: { code: string; message: string; provider?: string };

    constructor(key: string, previous?: { code: string; message: string; provider?: string }) {
        super(
            `la clé ${key} attend une réconciliation : un appel précédent a échoué sans `
            + `certitude sur ce qui a été engagé${previous ? ` (${previous.code})` : ''}. `
            + 'Interroge `fetchStatus()` avant toute nouvelle tentative.'
        );
        this.name = 'ReconciliationRequiredError';
        this.key = key;
        if (previous) this.previous = previous;
    }
}

/* ------------------------------------------------------------------ *
 * Store mémoire
 * ------------------------------------------------------------------ */

/** Store mémoire — développement et tests UNIQUEMENT. Ne protège qu'un seul processus. */
export class MemoryIdempotencyStore implements IdempotencyStore {
    private readonly map = new Map<string, IdempotencyRecord>();
    private readonly now: () => number;

    constructor(opts: { now?: () => number } = {}) {
        this.now = opts.now ?? Date.now;
    }

    private purge(key: string, ttlMs: number): void {
        const rec = this.map.get(key);
        if (rec && this.now() - rec.createdAt > ttlMs) this.map.delete(key);
    }

    async reserve(key: string, ttlMs: number): Promise<IdempotencyRecord | null> {
        this.purge(key, ttlMs);
        const existing = this.map.get(key);
        if (existing) return existing;
        this.map.set(key, { key, state: 'in_flight', createdAt: this.now() });
        return null;
    }

    async complete(key: string, result: PaymentResult): Promise<void> {
        const rec = this.map.get(key);
        this.map.set(key, {
            key,
            state: 'completed',
            result,
            createdAt: rec?.createdAt ?? this.now(),
        });
    }

    async markForReconciliation(
        key: string,
        error: { code: string; message: string; provider?: string }
    ): Promise<void> {
        const rec = this.map.get(key);
        this.map.set(key, {
            key,
            state: 'needs_reconciliation',
            error,
            createdAt: rec?.createdAt ?? this.now(),
        });
    }

    async release(key: string): Promise<void> {
        this.map.delete(key);
    }

    async get(key: string): Promise<IdempotencyRecord | null> {
        return this.map.get(key) ?? null;
    }

    /** Clés en attente de réconciliation — c'est la file de travail du `Reconciler`. */
    async pendingReconciliation(): Promise<IdempotencyRecord[]> {
        return [...this.map.values()].filter((r) => r.state === 'needs_reconciliation');
    }

    size(): number {
        return this.map.size;
    }
}

/* ------------------------------------------------------------------ *
 * Store SQL — production
 * ------------------------------------------------------------------ */

/**
 * Verrou d'idempotence adossé à une base SQL.
 *
 * C'est le store à utiliser en production : le verrou doit être partagé par
 * tous les processus, et un `Map` en mémoire ne protège que le sien. Deux
 * instances d'une API derrière un répartiteur de charge, et le double paiement
 * revient par la porte de service.
 *
 * Aucune dépendance : l'hôte fournit son `SqlRunner` (voir `sql.ts`).
 *
 * La table attendue — c'est la BASE qui porte l'unicité, pas du code :
 *
 * ```sql
 * CREATE TABLE sankore_idempotency (
 *   key         TEXT PRIMARY KEY,
 *   state       TEXT NOT NULL CHECK (state IN ('in_flight','completed','needs_reconciliation')),
 *   result      JSONB,
 *   error       JSONB,
 *   created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
 * );
 * CREATE INDEX ON sankore_idempotency (state, created_at);
 * ```
 *
 * `PRIMARY KEY` sur `key` est ce qui rend `reserve` atomique. Sans elle, deux
 * requêtes simultanées s'insèrent toutes les deux et la garantie disparaît
 * sans qu'aucun test ne le voie.
 */
export class SqlIdempotencyStore implements IdempotencyStore {
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
        this.table = opts.table ?? 'sankore_idempotency';
        this.ph = opts.placeholder ?? PG_PLACEHOLDER;
        this.now = opts.now ?? Date.now;
    }

    private row(raw: Record<string, unknown> | undefined): IdempotencyRecord | null {
        if (!raw) return null;
        const key = typeof raw['key'] === 'string' ? raw['key'] : '';
        const state = raw['state'];
        if (!key || typeof state !== 'string') return null;

        const rec: IdempotencyRecord = {
            key,
            state: state as IdempotencyState,
            createdAt: toMillis(raw['created_at']) ?? this.now(),
        };
        const result = parseJson(raw['result']);
        if (result) rec.result = result as PaymentResult;
        const error = parseJson(raw['error']);
        if (error) rec.error = error as IdempotencyRecord['error'];
        return rec;
    }

    async reserve(key: string, ttlMs: number): Promise<IdempotencyRecord | null> {
        const now = new Date(this.now()).toISOString();
        const expiry = new Date(this.now() - ttlMs).toISOString();

        // Une entrée périmée est reprise par l'insertion elle-même : on la
        // supprime d'abord, dans la même aller-retour logique. Sans cette
        // purge, une référence légitime resterait bloquée par un verrou mort.
        await this.run(
            `DELETE FROM ${this.table} WHERE key = ${this.ph(1)} AND created_at < ${this.ph(2)}`,
            [key, expiry]
        );

        const inserted = await this.run(
            `INSERT INTO ${this.table} (key, state, created_at) VALUES (${this.ph(1)}, 'in_flight', ${this.ph(2)}) `
            + 'ON CONFLICT (key) DO NOTHING',
            [key, now]
        );
        if (inserted.affected > 0) return null;

        return this.get(key);
    }

    async complete(key: string, result: PaymentResult): Promise<void> {
        await this.run(
            `UPDATE ${this.table} SET state = 'completed', result = ${this.ph(2)}, error = NULL WHERE key = ${this.ph(1)}`,
            [key, JSON.stringify(result)]
        );
    }

    async markForReconciliation(
        key: string,
        error: { code: string; message: string; provider?: string }
    ): Promise<void> {
        await this.run(
            `UPDATE ${this.table} SET state = 'needs_reconciliation', error = ${this.ph(2)} WHERE key = ${this.ph(1)}`,
            [key, JSON.stringify(error)]
        );
    }

    async release(key: string): Promise<void> {
        await this.run(`DELETE FROM ${this.table} WHERE key = ${this.ph(1)}`, [key]);
    }

    async get(key: string): Promise<IdempotencyRecord | null> {
        const res = await this.run(
            `SELECT key, state, result, error, created_at FROM ${this.table} WHERE key = ${this.ph(1)}`,
            [key]
        );
        return this.row(res.rows[0]);
    }

    /**
     * Clés en attente de réconciliation, les plus anciennes d'abord.
     *
     * C'est la file de travail du `Reconciler`, et la requête à brancher sur une
     * alerte : une entrée qui y stagne est de l'argent dont personne ne sait
     * s'il est parti.
     */
    async pendingReconciliation(limit = 100): Promise<IdempotencyRecord[]> {
        const res = await this.run(
            `SELECT key, state, result, error, created_at FROM ${this.table} `
            + `WHERE state = 'needs_reconciliation' ORDER BY created_at ASC LIMIT ${this.ph(1)}`,
            [limit]
        );
        return res.rows.map((r) => this.row(r)).filter((r): r is IdempotencyRecord => r !== null);
    }

    /**
     * Supprime les verrous terminés et périmés.
     *
     * Ne touche JAMAIS aux entrées `needs_reconciliation` : les purger
     * reviendrait à oublier une incertitude sur un mouvement d'argent. Elles se
     * résolvent par réconciliation, pas par expiration.
     */
    async purge(olderThanMs: number): Promise<number> {
        const res = await this.run(
            `DELETE FROM ${this.table} WHERE state IN ('completed','in_flight') AND created_at < ${this.ph(1)}`,
            [new Date(this.now() - olderThanMs).toISOString()]
        );
        return res.affected;
    }
}

function parseJson(value: unknown): unknown {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'object') return value;          // pilote qui désérialise déjà (pg + jsonb)
    if (typeof value !== 'string' || !value) return undefined;
    try { return JSON.parse(value); } catch { return undefined; }
}

function toMillis(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') {
        const at = Date.parse(value);
        return Number.isNaN(at) ? undefined : at;
    }
    return undefined;
}

/* ------------------------------------------------------------------ *
 * Enveloppe
 * ------------------------------------------------------------------ */

export interface IdempotencyOptions {
    store: IdempotencyStore;
    /** Durée de rétention d'une clé. 24 h par défaut. */
    ttlMs?: number;
    observer?: Observer;
    /** Référence applicative, pour les observations. À défaut, la clé est utilisée. */
    reference?: string;
}

/**
 * Détermine s'il est SÛR de relâcher la clé après un échec.
 *
 * Vrai uniquement quand l'erreur prouve que le fournisseur n'a rien engagé :
 * requête refusée, identifiants invalides, solde insuffisant, service
 * indisponible avant traitement.
 *
 * Faux dans deux cas, et c'est délibérément conservateur :
 *
 * - l'erreur exige une réconciliation (`network_timeout`, `provider_error`,
 *   `unknown`) — on ne sait pas ce qui est parti ;
 * - l'erreur n'est pas une `PaymentError` du tout. Une exception inattendue au
 *   milieu d'un adaptateur a pu survenir APRÈS que la requête HTTP a abouti.
 *   Un bogue de notre côté ne doit pas se payer en double virement.
 */
export function safeToRelease(err: unknown): boolean {
    return err instanceof PaymentError && !err.needsReconciliation;
}

/**
 * Exécute `fn` au plus une fois par clé.
 *
 * - clé libre                  -> exécution, puis mémorisation du résultat
 * - clé terminée               -> renvoi du résultat mémorisé, sans réexécuter
 * - clé en cours               -> `DuplicateInFlightError`
 * - clé à réconcilier          -> `ReconciliationRequiredError`
 *
 * En cas d'échec de `fn`, la clé n'est libérée que s'il est certain que rien
 * n'a été engagé — voir `safeToRelease`. Sinon elle passe en
 * `needs_reconciliation` et reste prise.
 */
export async function withIdempotency(
    key: string,
    opts: IdempotencyOptions,
    fn: () => Promise<PaymentResult>
): Promise<PaymentResult> {
    const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    const observe = safeObserver(opts.observer);
    const reference = opts.reference ?? key;
    const existing = await opts.store.reserve(key, ttlMs);

    if (existing) {
        observe({
            kind: 'payment.duplicate',
            at: Date.now(),
            reference,
            detail: { key, state: existing.state },
        });

        if (existing.state === 'completed' && existing.result) return existing.result;
        if (existing.state === 'needs_reconciliation') {
            throw new ReconciliationRequiredError(key, existing.error);
        }
        throw new DuplicateInFlightError(key);
    }

    try {
        const result = await fn();
        await opts.store.complete(key, result);
        return result;
    } catch (err) {
        if (safeToRelease(err)) {
            await opts.store.release(key);
        } else {
            const pe = err instanceof PaymentError ? err : undefined;
            const info: { code: string; message: string; provider?: string } = {
                code: pe?.code ?? 'unknown',
                message: err instanceof Error ? err.message : String(err),
            };
            if (pe?.provider) info.provider = pe.provider;
            await opts.store.markForReconciliation(key, info);
        }
        throw err;
    }
}

/**
 * Clôt une réconciliation : on a constaté l'état réel, on l'inscrit.
 *
 * C'est la seule sortie légitime de `needs_reconciliation`. Si l'état constaté
 * est final, la clé passe en `completed` et portera désormais ce résultat — un
 * rejeu ultérieur le rendra au lieu de relancer un paiement. S'il ne l'est pas
 * encore, la clé reste en attente : rien n'est tranché, donc rien ne change.
 */
export async function resolveReconciliation(
    key: string,
    store: IdempotencyStore,
    observed: PaymentResult,
    isFinalStatus: (status: PaymentResult['status']) => boolean
): Promise<'completed' | 'still_pending'> {
    if (!isFinalStatus(observed.status)) return 'still_pending';
    await store.complete(key, observed);
    return 'completed';
}
