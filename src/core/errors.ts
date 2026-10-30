/**
 * Taxonomie d'erreurs normalisée.
 *
 * Chaque fournisseur a son propre dialecte : InTouch répond « 1004 », Bizao
 * « INSUFFICIENT_BALANCE », un autre un HTTP 402 avec un texte français.
 * Sans normalisation, chaque application réécrit le même `switch` géant.
 *
 * Le point décisif est `retryable` : rejouer une erreur non rejouable, c'est
 * risquer un double paiement. C'est LA distinction qui protège l'argent.
 */

export type ErrorCode =
    // --- Le client peut agir ---
    | 'insufficient_funds'      // solde insuffisant
    | 'invalid_account'         // numéro / compte inexistant
    | 'account_limit_exceeded'  // plafond réglementaire ou opérateur atteint
    | 'account_blocked'         // compte gelé, KYC incomplet
    | 'wrong_pin'               // code erroné côté client
    | 'customer_declined'       // le client a refusé la demande sur son téléphone

    // --- Problème d'intégration (côté nous) ---
    | 'invalid_request'         // payload malformé
    | 'authentication_failed'   // identifiants API invalides
    | 'unsupported_corridor'    // pays × rail × devise non couvert
    | 'duplicate_request'       // idempotence : requête déjà traitée
    | 'not_found'               // la ressource interrogée n'existe pas chez le fournisseur

    // --- Transitoire : REJOUABLE ---
    | 'provider_unavailable'    // 5xx, maintenance opérateur
    | 'network_timeout'         // pas de réponse à temps
    | 'rate_limited'            // trop d'appels

    // --- Zone grise ---
    | 'provider_error'          // erreur fournisseur non catégorisée
    | 'unknown';                // aucune correspondance trouvée

/** Tous les codes, dans l'ordre de déclaration. Utile pour générer un catalogue. */
export const ERROR_CODES: readonly ErrorCode[] = [
    'insufficient_funds', 'invalid_account', 'account_limit_exceeded', 'account_blocked',
    'wrong_pin', 'customer_declined',
    'invalid_request', 'authentication_failed', 'unsupported_corridor', 'duplicate_request',
    'not_found',
    'provider_unavailable', 'network_timeout', 'rate_limited',
    'provider_error', 'unknown',
];

/**
 * Erreurs qu'il est SÛR de rejouer : elles garantissent qu'aucune opération
 * n'a été engagée côté fournisseur.
 *
 * `network_timeout` est volontairement ABSENT : un délai dépassé ne dit RIEN
 * sur ce qui s'est passé en face. Le paiement a pu aboutir. On ne rejoue
 * jamais à l'aveugle — on interroge d'abord le statut réel.
 */
const RETRYABLE: readonly ErrorCode[] = [
    'provider_unavailable',
    'rate_limited',
];

/** Erreurs imposant de VÉRIFIER l'état réel avant toute décision. */
const NEEDS_RECONCILIATION: readonly ErrorCode[] = [
    'network_timeout',
    'provider_error',
    'unknown',
];

export function isRetryable(code: ErrorCode): boolean {
    return RETRYABLE.includes(code);
}

export function needsReconciliation(code: ErrorCode): boolean {
    return NEEDS_RECONCILIATION.includes(code);
}

/* ------------------------------------------------------------------ *
 * Messages destinés au client final
 * ------------------------------------------------------------------ */

/**
 * Langue des messages présentés au client.
 *
 * Deux langues sont livrées parce que les corridors couverts les imposent
 * toutes les deux : le français pour l'UEMOA et la CEMAC, l'anglais pour le
 * Nigeria et le Ghana — dont les devises (NGN, GHS) sont dans `Currency`.
 * Livrer une bibliothèque monolingue sur cette géographie serait une faute.
 *
 * La liste est ouverte : `registerCustomerMessages()` accepte n'importe quelle
 * étiquette de langue, pour le portugais de Guinée-Bissau comme pour le bambara
 * ou le wolof.
 */
export type Locale = 'fr' | 'en' | (string & {});

/** Message destiné à l'utilisateur final, sans jargon technique. */
const MESSAGES_FR: Record<ErrorCode, string> = {
    insufficient_funds: "Solde insuffisant sur le compte.",
    invalid_account: "Ce numéro ne correspond à aucun compte actif.",
    account_limit_exceeded: "Le plafond autorisé pour ce compte est atteint.",
    account_blocked: "Ce compte est bloqué. Contactez votre opérateur.",
    wrong_pin: "Code secret incorrect.",
    customer_declined: "La demande a été refusée sur le téléphone.",
    invalid_request: "La demande est invalide.",
    authentication_failed: "Erreur de configuration du service de paiement.",
    unsupported_corridor: "Ce pays ou ce moyen de paiement n'est pas disponible.",
    duplicate_request: "Cette opération a déjà été traitée.",
    not_found: "Cette opération est introuvable.",
    provider_unavailable: "Le service de paiement est momentanément indisponible.",
    network_timeout: "Délai dépassé. Le statut sera vérifié automatiquement.",
    rate_limited: "Trop de demandes. Réessayez dans un instant.",
    provider_error: "Erreur du service de paiement.",
    unknown: "Une erreur inattendue est survenue.",
};

const MESSAGES_EN: Record<ErrorCode, string> = {
    insufficient_funds: "Insufficient balance on the account.",
    invalid_account: "This number does not match any active account.",
    account_limit_exceeded: "The account limit has been reached.",
    account_blocked: "This account is blocked. Please contact your operator.",
    wrong_pin: "Incorrect PIN.",
    customer_declined: "The request was declined on the phone.",
    invalid_request: "The request is invalid.",
    authentication_failed: "Payment service configuration error.",
    unsupported_corridor: "This country or payment method is not available.",
    duplicate_request: "This operation has already been processed.",
    not_found: "This operation could not be found.",
    provider_unavailable: "The payment service is temporarily unavailable.",
    network_timeout: "Request timed out. The status will be verified automatically.",
    rate_limited: "Too many requests. Please try again shortly.",
    provider_error: "Payment service error.",
    unknown: "An unexpected error occurred.",
};

const CATALOG = new Map<string, Record<ErrorCode, string>>([
    ['fr', MESSAGES_FR],
    ['en', MESSAGES_EN],
]);

/** Langue de repli quand celle demandée n'est pas connue. */
export const DEFAULT_LOCALE = 'fr';

/**
 * Ajoute ou remplace une langue.
 *
 * Le catalogue doit être COMPLET : un `Record<ErrorCode, string>` partiel
 * laisserait des trous qui ne se verraient qu'au moment d'afficher l'erreur la
 * plus rare — c'est-à-dire au pire moment. Le type l'impose.
 *
 *     registerCustomerMessages('pt', { insufficient_funds: 'Saldo insuficiente.', … });
 */
export function registerCustomerMessages(locale: Locale, messages: Record<ErrorCode, string>): void {
    CATALOG.set(locale.toLowerCase(), { ...messages });
}

/** Étiquettes de langue disponibles. */
export function availableLocales(): string[] {
    return [...CATALOG.keys()];
}

/**
 * Message présentable au client final.
 *
 * Replis successifs : la langue exacte (`fr-SN`), sa base (`fr`), puis le
 * français. Mieux vaut un message dans la mauvaise langue qu'un `undefined`
 * affiché à un client en train de payer.
 */
export function customerMessage(code: ErrorCode, locale: Locale = DEFAULT_LOCALE): string {
    const tag = locale.toLowerCase();
    const base = tag.split('-')[0] ?? tag;
    const table = CATALOG.get(tag) ?? CATALOG.get(base) ?? MESSAGES_FR;
    return table[code] ?? MESSAGES_FR[code];
}

/* ------------------------------------------------------------------ *
 * L'erreur
 * ------------------------------------------------------------------ */

export class PaymentError extends Error {
    readonly code: ErrorCode;
    // Explicitement nullables et non optionnels : un champ de classe alimenté
    // par une option absente VAUT `undefined`, il n'est pas « absent ».
    /** Code brut du fournisseur, conservé pour le support et le débogage. */
    readonly providerCode: string | undefined;
    readonly provider: string | undefined;
    readonly retryable: boolean;
    readonly needsReconciliation: boolean;
    /**
     * Délai avant un nouvel essai, quand le fournisseur l'a indiqué —
     * en-tête `Retry-After` sur un 429 ou un 503.
     *
     * Honorer ce délai plutôt que le deviner est la différence entre une
     * limite de débit qui se résorbe et une clé d'API suspendue.
     */
    readonly retryAfterMs?: number;

    constructor(opts: {
        code: ErrorCode;
        message?: string;
        providerCode?: string;
        provider?: string;
        retryAfterMs?: number;
        cause?: unknown;
    }) {
        super(opts.message ?? customerMessage(opts.code));
        this.name = 'PaymentError';
        this.code = opts.code;
        this.providerCode = opts.providerCode;
        this.provider = opts.provider;
        this.retryable = isRetryable(opts.code);
        this.needsReconciliation = needsReconciliation(opts.code);
        if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
        if (opts.cause !== undefined) this.cause = opts.cause;
    }

    /** Message présentable à l'utilisateur final, dans la langue demandée. */
    customerMessage(locale: Locale = DEFAULT_LOCALE): string {
        return customerMessage(this.code, locale);
    }

    /**
     * Forme sérialisable.
     *
     * Ne contient AUCUNE donnée du fournisseur au-delà de son code : ni corps
     * de réponse, ni en-têtes, ni `cause`. C'est ce qui permet de la journaliser
     * ou de la renvoyer dans une réponse d'API sans relire ce qu'elle contient.
     */
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            provider: this.provider,
            providerCode: this.providerCode,
            retryable: this.retryable,
            needsReconciliation: this.needsReconciliation,
            retryAfterMs: this.retryAfterMs,
        };
    }
}
