/**
 * Machine à états d'un paiement.
 *
 * Chaque fournisseur invente son vocabulaire : « PENDING », « EN_COURS »,
 * « 00 », « SUCCESS », « ACCEPTED »… Le rôle de ce module est d'imposer UN
 * vocabulaire unique côté application, et de refuser les transitions absurdes.
 *
 * Règle métier essentielle : un paiement `succeeded` ne peut PAS redevenir
 * `failed`. Certains fournisseurs envoient des webhooks en désordre ; sans
 * garde-fou, un webhook retardataire écrase un succès et la comptabilité ment.
 */

export type PaymentStatus =
    | 'pending'          // créé localement, pas encore transmis
    | 'action_required'  // le CLIENT doit agir : code OTP, USSD, redirection
    | 'processing'       // accepté par le fournisseur, en cours
    | 'succeeded'        // fonds transférés — état FINAL
    | 'failed'           // échec définitif — état FINAL
    | 'reversed'         // succès puis annulé/remboursé — état FINAL
    | 'expired';         // jamais confirmé dans le délai — état FINAL

/**
 * `action_required` existe pour l'ENCAISSEMENT. Décaisser est un ordre : on
 * envoie, ça part. Encaisser est une demande : le client doit composer un code
 * USSD, saisir un OTP ou revenir d'une page de redirection. Tant qu'il ne l'a
 * pas fait, l'opération n'est ni en cours ni échouée — elle attend une personne.
 *
 * Confondre cet état avec `processing` conduit à interroger en boucle un
 * paiement qui n'avancera jamais tout seul, et à ne jamais afficher au client
 * ce qu'on attend de lui.
 *
 * Note : `processing -> action_required` est autorisé. Certains fournisseurs
 * accusent réception avant de réclamer l'OTP — le retour en arrière est réel,
 * et le refuser ferait perdre l'action à afficher.
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
    pending: ['action_required', 'processing', 'failed', 'expired'],
    action_required: ['processing', 'succeeded', 'failed', 'expired'],
    processing: ['action_required', 'succeeded', 'failed', 'expired'],
    // Un paiement réussi ne peut QUE être annulé — jamais « échouer » après coup.
    succeeded: ['reversed'],
    failed: [],
    reversed: [],
    expired: [],
};

export const FINAL_STATUSES: readonly PaymentStatus[] = ['succeeded', 'failed', 'reversed', 'expired'];

export function isFinal(status: PaymentStatus): boolean {
    return FINAL_STATUSES.includes(status);
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
    return TRANSITIONS[from].includes(to);
}

export class StatusTransitionError extends Error {
    readonly from: PaymentStatus;
    readonly to: PaymentStatus;
    constructor(from: PaymentStatus, to: PaymentStatus) {
        super(`transition interdite : ${from} -> ${to}`);
        this.name = 'StatusTransitionError';
        this.from = from;
        this.to = to;
    }
}

/**
 * Applique une transition. Idempotent : re-appliquer le même état ne lève pas
 * d'erreur (les fournisseurs renvoient souvent deux fois le même webhook).
 */
export function transition(from: PaymentStatus, to: PaymentStatus): PaymentStatus {
    if (from === to) return from;
    if (!canTransition(from, to)) throw new StatusTransitionError(from, to);
    return to;
}

/**
 * Version tolérante, pour les webhooks arrivant dans le désordre.
 * Ignore une transition invalide au lieu de lever — mais le signale à l'appelant
 * pour qu'il puisse journaliser l'anomalie plutôt que de la subir en silence.
 */
export function tryTransition(
    from: PaymentStatus,
    to: PaymentStatus
): { status: PaymentStatus; applied: boolean; reason?: string } {
    if (from === to) return { status: from, applied: false, reason: 'déjà dans cet état' };
    if (!canTransition(from, to)) {
        return {
            status: from,
            applied: false,
            reason: isFinal(from)
                ? `${from} est un état final — webhook retardataire ignoré`
                : `transition ${from} -> ${to} non autorisée`,
        };
    }
    return { status: to, applied: true };
}
