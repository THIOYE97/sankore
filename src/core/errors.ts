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

    // --- Transitoire : REJOUABLE ---
    | 'provider_unavailable'    // 5xx, maintenance opérateur
    | 'network_timeout'         // pas de réponse à temps
    | 'rate_limited'            // trop d'appels

    // --- Zone grise ---
    | 'provider_error'          // erreur fournisseur non catégorisée
    | 'unknown';                // aucune correspondance trouvée

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

/** Message destiné à l'utilisateur final, en français, sans jargon technique. */
const CUSTOMER_MESSAGE: Record<ErrorCode, string> = {
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
    provider_unavailable: "Le service de paiement est momentanément indisponible.",
    network_timeout: "Délai dépassé. Le statut sera vérifié automatiquement.",
    rate_limited: "Trop de demandes. Réessayez dans un instant.",
    provider_error: "Erreur du service de paiement.",
    unknown: "Une erreur inattendue est survenue.",
};

export class PaymentError extends Error {
    readonly code: ErrorCode;
    /** Code brut du fournisseur, conservé pour le support et le débogage. */
    readonly providerCode?: string;
    readonly provider?: string;
    readonly retryable: boolean;
    readonly needsReconciliation: boolean;

    constructor(opts: {
        code: ErrorCode;
        message?: string;
        providerCode?: string;
        provider?: string;
        cause?: unknown;
    }) {
        super(opts.message ?? CUSTOMER_MESSAGE[opts.code]);
        this.name = 'PaymentError';
        this.code = opts.code;
        this.providerCode = opts.providerCode;
        this.provider = opts.provider;
        this.retryable = isRetryable(opts.code);
        this.needsReconciliation = needsReconciliation(opts.code);
        if (opts.cause !== undefined) this.cause = opts.cause;
    }

    /** Message présentable à l'utilisateur final. */
    customerMessage(): string {
        return CUSTOMER_MESSAGE[this.code];
    }

    toJSON() {
        return {
            code: this.code,
            message: this.message,
            provider: this.provider,
            providerCode: this.providerCode,
            retryable: this.retryable,
            needsReconciliation: this.needsReconciliation,
        };
    }
}

export function customerMessage(code: ErrorCode): string {
    return CUSTOMER_MESSAGE[code];
}
