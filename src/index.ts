/**
 * Sankoré — boîte à outils de paiement pour l'Afrique de l'Ouest.
 *
 * Un seul contrat pour le mobile money, la banque, la microfinance,
 * les portefeuilles et la carte — quel que soit l'agrégateur derrière.
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
