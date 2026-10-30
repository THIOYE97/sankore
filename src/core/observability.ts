/**
 * Observabilité — ce que la bibliothèque raconte d'elle-même.
 *
 * Une intégration de paiement qui ne se raconte pas est indéfendable en
 * production : quand un client affirme avoir payé, il faut pouvoir prouver ce
 * qui est parti, quand, vers quel fournisseur, et ce qui est revenu. Sans
 * traces, le support n'a que la parole du client contre celle de l'opérateur.
 *
 * Deux principes gouvernent ce module :
 *
 * 1. **Un seul point d'entrée.** `Observer` est une fonction. Elle se branche
 *    sur pino, winston, OpenTelemetry, Datadog ou un simple `console.log` sans
 *    que Sankoré connaisse aucun de ces outils — et donc sans dépendance.
 *
 * 2. **Rien ne sort en clair.** Tout ce qui traverse `redact()` perd ses
 *    secrets (clés d'API, jetons, OTP, codes PIN, signatures) et masque ses
 *    données personnelles (numéros de téléphone, noms, comptes). Une clé d'API
 *    recopiée dans un journal est une clé d'API compromise : elle survivra des
 *    années dans un index de logs, lisible par toute l'entreprise.
 *
 * L'observation ne doit JAMAIS faire échouer un paiement. Un `Observer` qui
 * lève est neutralisé par `safeObserver()` — perdre une ligne de journal est
 * désagréable, perdre un virement ne l'est pas.
 */

import type { ErrorCode } from './errors.ts';
import type { PaymentStatus } from './status.ts';

/* ------------------------------------------------------------------ *
 * Événements
 * ------------------------------------------------------------------ */

/**
 * Nature de l'événement observé.
 *
 * Le préfixe dit la couche : `http.*` la mécanique réseau, `payment.*` le
 * cycle de vie d'une opération, `breaker.*` la santé d'un fournisseur,
 * `webhook.*` le flux entrant, `reconcile.*` la boucle de rattrapage.
 */
export type ObservationKind =
    // --- Réseau ---
    | 'http.request'      // une requête part
    | 'http.response'     // réponse reçue, quel que soit son statut
    | 'http.retry'        // reprise programmée après une erreur rejouable
    | 'http.error'        // abandon après épuisement des reprises
    | 'http.throttled'    // le limiteur de débit a retenu la requête

    // --- Cycle de vie d'un paiement ---
    | 'payment.routed'       // un fournisseur a été choisi
    | 'payment.succeeded'
    | 'payment.failed'
    | 'payment.pending'      // accepté, pas encore tranché (processing, action_required…)
    | 'payment.duplicate'    // l'idempotence a intercepté un rejeu
    | 'payment.failover'     // bascule vers le fournisseur suivant
    | 'payment.unroutable'   // aucun fournisseur pour ce corridor

    // --- Santé des fournisseurs ---
    | 'breaker.opened'    // trop d'échecs : le fournisseur est écarté
    | 'breaker.half_open' // période d'essai : une requête est laissée passer
    | 'breaker.closed'    // le fournisseur est rétabli
    | 'breaker.rejected'  // requête refusée sans appel réseau

    // --- Webhooks ---
    | 'webhook.accepted'
    | 'webhook.rejected'  // signature invalide ou charge illisible
    | 'webhook.replayed'  // événement déjà traité, ignoré
    | 'webhook.ignored'   // transition non applicable (arrivée en désordre)

    // --- Réconciliation ---
    | 'reconcile.started'
    | 'reconcile.resolved'  // l'état réel a été obtenu et est final
    | 'reconcile.pending'   // toujours en cours chez le fournisseur
    | 'reconcile.failed'    // impossible d'interroger le fournisseur
    | 'reconcile.exhausted'; // abandon après le nombre maximal de tentatives

/**
 * Une observation. Volontairement plate : c'est ce qui la rend traduisible
 * en ligne de log structuré, en span de trace ou en métrique sans adaptation.
 *
 * Tous les champs sont optionnels sauf `kind` et `at`, parce que toutes les
 * couches ne connaissent pas tout : le client HTTP ignore la référence
 * applicative, le routeur ignore le statut HTTP.
 */
export interface Observation {
    kind: ObservationKind;
    /** Horodatage en millisecondes depuis l'époque Unix. */
    at: number;

    // Les champs ci-dessous sont déclarés `?: T | undefined` et non `?: T`.
    // C'est volontaire, et c'est le seul type du projet où ce choix est fait :
    // une observation se construit à partir de données partielles, et
    // « champ absent » n'y veut rien dire de plus que « champ à undefined ».
    // Imposer la nuance ici n'achèterait aucune garantie et obligerait chaque
    // site d'appel à bâtir son objet en trois lignes conditionnelles.

    /** Nom du fournisseur concerné. */
    provider?: string | undefined;
    /** Référence applicative de l'opération. */
    reference?: string | undefined;
    /** Statut normalisé du paiement, quand l'événement en porte un. */
    paymentStatus?: PaymentStatus | undefined;
    /** Code d'erreur normalisé. */
    code?: ErrorCode | undefined;
    /** Code brut du fournisseur, conservé pour le support. */
    providerCode?: string | undefined;
    /** Durée de l'opération en millisecondes, quand elle est mesurée. */
    durationMs?: number | undefined;
    /** Numéro de tentative, à partir de 1. */
    attempt?: number | undefined;
    /** Statut HTTP, pour les événements `http.*`. */
    httpStatus?: number | undefined;
    /** Méthode et chemin HTTP — le chemin est débarrassé de sa chaîne de requête. */
    method?: string | undefined;
    path?: string | undefined;
    /**
     * Contexte libre. Passé par `redact()` avant d'être transmis : y déposer un
     * objet contenant une clé d'API est sans conséquence.
     */
    detail?: Record<string, unknown> | undefined;
}

/**
 * Récepteur d'observations.
 *
 * Synchrone par contrat : Sankoré ne l'attend pas. Un `Observer` qui fait de
 * l'entrée/sortie doit la mettre en file lui-même, sans quoi il ajoute sa
 * latence à chaque paiement.
 */
export type Observer = (observation: Observation) => void;

/** Ne rien observer. Valeur par défaut partout. */
export const silentObserver: Observer = () => {};

/**
 * Enveloppe un `Observer` pour qu'il ne puisse pas faire échouer un paiement.
 *
 * Un journal défaillant — disque plein, agent de collecte mort, sérialisation
 * circulaire — ne doit jamais remonter dans la pile d'un virement. Les erreurs
 * d'observation sont avalées, délibérément et silencieusement : il n'existe
 * aucun endroit sûr où les signaler, puisque c'est précisément le journal qui
 * est en panne.
 */
export function safeObserver(observer: Observer | undefined): Observer {
    if (!observer) return silentObserver;
    return (observation) => {
        try {
            observer(observation);
        } catch {
            /* un journal cassé ne casse pas un paiement */
        }
    };
}

/** Diffuse chaque observation à plusieurs récepteurs — logs ET métriques. */
export function composeObservers(...observers: readonly Observer[]): Observer {
    const list = observers.map((o) => safeObserver(o));
    return (observation) => {
        for (const o of list) o(observation);
    };
}

/**
 * Observateur NDJSON — une observation par ligne, prête pour l'ingestion.
 *
 * `write` par défaut écrit sur la sortie standard. En conteneur, c'est
 * exactement ce qu'attend le collecteur de logs.
 */
export function jsonObserver(write: (line: string) => void = (l) => console.log(l)): Observer {
    return (observation) => {
        write(JSON.stringify({ ...observation, ts: new Date(observation.at).toISOString() }));
    };
}

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

/**
 * Noms de champs dont la valeur ne doit JAMAIS apparaître dans un journal.
 *
 * La comparaison se fait en minuscules et par inclusion : `apikey` attrape
 * aussi `ApiKey`, `api_key` et `hub2ApiKey`. Large volontairement — un faux
 * positif coûte une ligne de journal moins lisible, un faux négatif coûte une
 * fuite de secret.
 */
const SECRET_KEYS: readonly string[] = [
    'apikey', 'api_key', 'authorization', 'auth', 'token', 'secret',
    'password', 'passwd', 'pin', 'otp', 'confirmationcode', 'confirmation_code',
    'signature', 'merchantid', 'merchant_id', 'privatekey', 'private_key',
    'credential', 'cookie', 'bearer', 'cvv', 'cvn', 'cvc',
];

/**
 * Noms de champs portant une donnée personnelle : masqués, pas supprimés.
 *
 * La différence compte. Un secret n'a aucune raison d'être lisible ; un numéro
 * de téléphone, si : le support doit pouvoir rapprocher une réclamation d'une
 * trace. On en conserve donc assez pour identifier (`+223…9012`) sans exposer
 * l'annuaire complet de la clientèle dans l'index de logs.
 */
const PERSONAL_KEYS: readonly string[] = [
    'msisdn', 'phone', 'phonenumber', 'phone_number', 'telephone', 'mobile',
    'identifier', 'beneficiaryphone', 'beneficiary_phone',
    'iban', 'accountnumber', 'account_number', 'pan', 'cardnumber', 'card_number',
    'email', 'holdername', 'holder_name', 'recipientname', 'recipient_name',
    'customername', 'customer_name', 'firstname', 'lastname', 'address',
];

const SECRET_PLACEHOLDER = '[secret]';

function isSecretKey(key: string): boolean {
    const k = key.toLowerCase();
    return SECRET_KEYS.some((s) => k.includes(s));
}

function isPersonalKey(key: string): boolean {
    const k = key.toLowerCase();
    return PERSONAL_KEYS.some((s) => k.includes(s));
}

/**
 * Masque un numéro ou un identifiant de compte : `22370123456` -> `223…3456`.
 *
 * On garde le préfixe pays et les quatre derniers chiffres — de quoi rapprocher
 * une trace d'une réclamation, pas de quoi recomposer le numéro. En dessous de
 * huit caractères il n'y a plus rien à masquer utilement : tout part.
 */
export function maskIdentifier(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 8) return '…';
    const digits = trimmed.replace(/[^\d]/g, '');
    if (digits.length < 8) return `…${trimmed.slice(-2)}`;
    return `${digits.slice(0, 3)}…${digits.slice(-4)}`;
}

/** Masque un nom : `Awa Traoré` -> `A. T.`. Assez pour un rapprochement, pas pour un annuaire. */
function maskName(value: string): string {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '…';
    return parts.map((p) => `${p[0]?.toUpperCase() ?? ''}.`).join(' ');
}

function maskPersonal(key: string, value: string): string {
    const k = key.toLowerCase();
    if (k.includes('name')) return maskName(value);
    if (k.includes('email')) {
        const at = value.indexOf('@');
        return at > 0 ? `…@${value.slice(at + 1)}` : '…';
    }
    return maskIdentifier(value);
}

export interface RedactOptions {
    /** Profondeur maximale explorée. 6 par défaut. */
    maxDepth?: number;
    /** Nombre maximal d'éléments conservés par tableau. 20 par défaut. */
    maxArray?: number;
    /** Longueur maximale d'une chaîne conservée. 2 000 par défaut. */
    maxString?: number;
    /** Champs supplémentaires à traiter comme secrets, en plus de la liste intégrée. */
    extraSecretKeys?: readonly string[];
}

/**
 * Rend une valeur publiable dans un journal.
 *
 * Trois choses à la fois, parce qu'elles sont indissociables en pratique :
 *
 * - **Secrets supprimés.** Remplacés par `[secret]`, jamais tronqués : la
 *   moitié d'une clé d'API reste une information qu'on n'a pas à donner.
 * - **Données personnelles masquées.** Conservées sous forme partielle, pour
 *   que le support garde de quoi travailler.
 * - **Volume borné.** Profondeur, longueur des chaînes et taille des tableaux
 *   plafonnées, et cycles détectés. Les réponses brutes des agrégateurs sont
 *   grosses et parfois auto-référencées ; une bibliothèque de paiement n'a pas
 *   à faire exploser la facture d'ingestion de logs de son hôte.
 *
 * Fonction pure : la valeur d'origine n'est jamais modifiée.
 */
export function redact(value: unknown, opts: RedactOptions = {}): unknown {
    const maxDepth = opts.maxDepth ?? 6;
    const maxArray = opts.maxArray ?? 20;
    const maxString = opts.maxString ?? 2_000;
    const extra = (opts.extraSecretKeys ?? []).map((k) => k.toLowerCase());
    const seen = new WeakSet<object>();

    const secret = (key: string): boolean =>
        isSecretKey(key) || extra.some((s) => key.toLowerCase().includes(s));

    const walk = (v: unknown, depth: number): unknown => {
        if (v === null || v === undefined) return v;

        if (typeof v === 'string') {
            return v.length > maxString ? `${v.slice(0, maxString)}…[tronqué]` : v;
        }
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return v;
        if (typeof v === 'function' || typeof v === 'symbol') return undefined;

        if (v instanceof Date) return v.toISOString();
        if (v instanceof Error) {
            return { name: v.name, message: v.message };
        }

        if (depth >= maxDepth) return '[profondeur maximale atteinte]';

        if (Array.isArray(v)) {
            if (seen.has(v)) return '[cycle]';
            seen.add(v);
            const kept = v.slice(0, maxArray).map((item) => walk(item, depth + 1));
            if (v.length > maxArray) kept.push(`…${v.length - maxArray} éléments omis`);
            return kept;
        }

        if (typeof v === 'object') {
            if (seen.has(v)) return '[cycle]';
            seen.add(v);
            const out: Record<string, unknown> = {};
            for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
                if (secret(key)) {
                    out[key] = SECRET_PLACEHOLDER;
                    continue;
                }
                if (isPersonalKey(key) && typeof raw === 'string') {
                    out[key] = maskPersonal(key, raw);
                    continue;
                }
                const walked = walk(raw, depth + 1);
                if (walked !== undefined) out[key] = walked;
            }
            return out;
        }

        return undefined;
    };

    return walk(value, 0);
}

/**
 * Débarrasse un chemin HTTP de sa chaîne de requête.
 *
 * `/payment-intents?purchaseReference=CMD-42` porte la référence d'un client
 * dans l'URL. Les journaux d'accès conservent les URL très longtemps et sont
 * souvent les moins protégés de la chaîne : on n'y met pas de référence métier.
 */
export function scrubPath(path: string): string {
    const q = path.indexOf('?');
    return q === -1 ? path : path.slice(0, q);
}
