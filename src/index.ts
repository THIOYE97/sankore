/**
 * Sankoré — boîte à outils de paiement pour l'Afrique de l'Ouest.
 *
 * Un seul contrat pour le mobile money, la banque, la microfinance,
 * les portefeuilles et la carte — quel que soit l'agrégateur derrière.
 *
 * Copyright © 2026 RelayOps — Bamako, Mali. <contact@relayops.africa>
 *
 * Ce programme est un logiciel libre : vous pouvez le redistribuer et le
 * modifier selon les termes de la GNU Affero General Public License, version 3
 * ou toute version ultérieure, publiée par la Free Software Foundation.
 *
 * Il est distribué dans l'espoir qu'il sera utile, mais SANS AUCUNE GARANTIE,
 * ni explicite ni implicite. Voir la GNU AGPL pour les détails : le fichier
 * LICENSE, ou https://www.gnu.org/licenses/.
 *
 * Pour un usage en produit ou service propriétaire, une licence commerciale
 * est disponible : contact@relayops.africa
 */

export { Money, MoneyError, currencyExponent } from './core/money.ts';
export type { Currency } from './core/money.ts';

export {
    transition,
    tryTransition,
    canTransition,
    isFinal,
    FINAL_STATUSES,
    StatusTransitionError,
} from './core/status.ts';
export type { PaymentStatus } from './core/status.ts';

export { PaymentError, isRetryable, needsReconciliation, customerMessage } from './core/errors.ts';
export type { ErrorCode } from './core/errors.ts';

export type {
    PaymentProvider,
    PaymentRequest,
    PaymentResult,
    PaymentAction,
    Capability,
    Account,
    WebhookEvent,
    Rail,
    CountryCode,
    Direction,
} from './core/provider.ts';

export { Router } from './core/router.ts';
export type { RouteQuery, RouterOptions, RankFn } from './core/router.ts';

export {
    withIdempotency,
    MemoryIdempotencyStore,
    DuplicateInFlightError,
} from './core/idempotency.ts';
export type { IdempotencyStore, IdempotencyRecord, IdempotencyOptions } from './core/idempotency.ts';

// Mécanique HTTP réutilisable par tout adaptateur fournisseur.
export { HttpClient, mapHttpStatus, verifyHmacSignature } from './core/http.ts';
export type { HttpOptions, HttpRequest, HttpResponse } from './core/http.ts';

// Fournisseur simulateur — tests d'intégration et démonstrations.
export { SandboxProvider } from './providers/sandbox.ts';
export type { SandboxOptions, Scenario } from './providers/sandbox.ts';

// Adaptateurs vers les agrégateurs réels.
export { Hub2Provider } from './providers/hub2.ts';
export type { Hub2Options, Hub2RedirectionUrls } from './providers/hub2.ts';
