/**
 * Hub2 — encaissement (PAY-IN).
 *
 * Décaisser est un ordre : on envoie, ça part. Encaisser est une **demande** :
 * il faut qu'une personne, quelque part, compose un code sur son téléphone.
 * Hub2 modélise cela en deux objets — un `PaymentIntent` qui porte l'intention
 * de collecter une somme, et des `Payment` qui sont les tentatives faites
 * dessus. Une intention peut porter plusieurs tentatives : un client qui se
 * trompe de code n'invalide pas la commande.
 *
 * Le parcours complet :
 *
 *   1. `POST /payment-intents`                     -> payment_required
 *   2. `POST /payment-intents/{id}/payments`       -> processing | action_required
 *   3. selon `nextAction` :
 *        otp         -> `POST /payment-intents/{id}/authentication`
 *        ussd        -> le client compose, on attend le webhook
 *        redirection -> le client part sur une page externe, on attend le webhook
 *   4. successful | failed
 *
 * Les étapes 1 et 2 sont enchaînées par `collect()` : l'appelant de Sankoré
 * fournit dès le départ le montant ET le numéro du payeur, il n'y a donc aucune
 * raison de lui imposer deux appels. L'étape 3 est rendue à l'appelant, parce
 * qu'elle attend un humain.
 *
 * Références (vérifiées le 5 août 2026) :
 *   - OpenAPI     https://api.hub2.io/docs-json  (v2.156.0)
 *   - Intégration https://docs.hub2.io/integration/en/payments/payments_integration
 */

import type { Currency } from '../core/money.ts';
import { Money } from '../core/money.ts';
import { PaymentError } from '../core/errors.ts';
import type { ErrorCode } from '../core/errors.ts';
import type { PaymentStatus } from '../core/status.ts';
import type { HttpClient } from '../core/http.ts';
import type {
    PaymentRequest, PaymentResult, PaymentAction,
} from '../core/provider.ts';
import {
    assertReference, toMsisdn, sumFees, mostRecent,
    type Hub2RedirectionUrls,
} from './hub2-shared.ts';

/* ------------------------------------------------------------------ *
 * Correspondances
 * ------------------------------------------------------------------ */

/**
 * Statuts d'une intention d'encaissement.
 *
 * `payment_required` est le point de départ : l'intention existe, aucune
 * tentative n'a encore été faite. Rien n'a bougé, donc `pending`.
 *
 * `canceled` devient `failed` : Sankoré n'a pas d'état « annulé » distinct, et
 * du point de vue de la caisse le résultat est le même — l'argent n'est pas
 * rentré. La nuance survit dans le code d'erreur.
 */
const INTENT_STATUS: Record<string, PaymentStatus> = {
    payment_required: 'pending',
    action_required: 'action_required',
    processing: 'processing',
    successful: 'succeeded',
    failed: 'failed',
    canceled: 'failed',
};

/**
 * Les 29 causes d'échec d'un encaissement, traduites dans la taxonomie de Sankoré.
 *
 * Elles sont plus nombreuses que celles du décaissement parce qu'un
 * encaissement peut échouer **du fait du client** : mauvais code, refus,
 * abandon, plafond. C'est la différence de nature entre envoyer et demander.
 */
const PAYMENT_FAILURE: Record<string, ErrorCode> = {
    // --- Le client, ou son compte ---
    customer_insufficient_funds: 'insufficient_funds',
    customer_account_locked: 'account_blocked',
    blacklisted_msisdn: 'account_blocked',
    fraud_suspicion: 'account_blocked',
    forbidden_by_provider: 'account_blocked',
    msisdn_invalid: 'invalid_account',
    payer_quota_exceeded: 'account_limit_exceeded',
    payment_limit_reached: 'account_limit_exceeded',
    canceled_by_customer: 'customer_declined',
    canceled: 'customer_declined',

    // --- L'authentification : le code ---
    authentication_failed: 'wrong_pin',
    // Le client n'a pas saisi son code à temps. Il n'a pas refusé, mais du point
    // de vue de la caisse le paiement n'a pas eu lieu de son fait.
    authentication_timeout: 'customer_declined',

    // --- La carte ---
    card_expired: 'invalid_account',
    card_invalid: 'invalid_account',
    card_stolen: 'account_blocked',
    card_declined: 'customer_declined',
    card_refused: 'customer_declined',
    card_cvn_invalid: 'wrong_pin',
    address_verification_failed: 'invalid_request',

    // --- Nous, ou la requête ---
    bad_parameters: 'invalid_request',
    invalid_amount: 'invalid_request',
    invalid_payment_processor: 'invalid_request',
    unsupported_currency: 'unsupported_corridor',
    duplicate_request: 'duplicate_request',

    // --- Le réseau, le fournisseur ---
    service_unavailable: 'provider_unavailable',
    too_many_request: 'rate_limited',
    timeout: 'network_timeout',
    internal_error: 'provider_error',
    unknown_reason: 'unknown',
};

/* ------------------------------------------------------------------ *
 * Formes de réponse Hub2 (sous-ensemble utilisé)
 * ------------------------------------------------------------------ */

interface Hub2NextAction {
    type?: unknown;
    message?: unknown;
    data?: { url?: unknown; method?: unknown; data?: unknown } | null;
}

interface Hub2Payment {
    id?: unknown;
    status?: unknown;
    fees?: unknown;
    createdAt?: unknown;
    providerReference?: unknown;
    failure?: { code?: unknown; message?: unknown } | null;
}

export interface Hub2Intent {
    id?: unknown;
    token?: unknown;
    status?: unknown;
    amount?: unknown;
    currency?: unknown;
    createdAt?: unknown;
    purchaseReference?: unknown;
    customerReference?: unknown;
    payments?: unknown;
    nextAction?: Hub2NextAction | null;
    lastPaymentFailure?: { code?: unknown; message?: unknown } | null;
}

/* ------------------------------------------------------------------ *
 * Encaisseur
 * ------------------------------------------------------------------ */

export interface Hub2PayInConfig {
    name: string;
    businessName?: string | undefined;
    redirection?: Hub2RedirectionUrls | undefined;
    orangeWorkflow?: 'redirection' | 'otp' | undefined;
}

export class Hub2PayIn {
    // Champs déclarés explicitement : les propriétés de paramètres de
    // constructeur ne sont pas de l'annotation mais de la génération de code,
    // et `node --experimental-strip-types` efface, il ne transforme pas.
    private readonly http: HttpClient;
    private readonly cfg: Hub2PayInConfig;

    constructor(http: HttpClient, cfg: Hub2PayInConfig) {
        this.http = http;
        this.cfg = cfg;
    }

    private get name(): string {
        return this.cfg.name;
    }

    /**
     * Crée l'intention si besoin, puis lance la tentative de paiement.
     *
     * **Idempotent sur `request.reference`.** On regarde d'abord si une
     * intention porte déjà cette référence :
     *   - si elle porte déjà une tentative, on rend son état sans rien relancer ;
     *   - si elle existe sans tentative, on la réutilise ;
     *   - sinon on la crée.
     *
     * Sans cette lecture préalable, deux appels avec la même référence
     * créeraient deux intentions et débiteraient le client deux fois. C'est
     * exactement le scénario que cette bibliothèque existe pour empêcher.
     */
    async collect(request: PaymentRequest): Promise<PaymentResult> {
        assertReference(request.reference, this.name);
        if (!request.amount.isPositive()) {
            throw new PaymentError({
                code: 'invalid_request',
                provider: this.name,
                message: `montant invalide : ${request.amount.toString()}`,
            });
        }
        if (request.account.rail !== 'mobile_money') {
            throw new PaymentError({
                code: 'unsupported_corridor',
                provider: this.name,
                message: `Hub2 : l'encaissement par « ${request.account.rail} » n'est pas couvert `
                    + '(la carte exige des données de facturation absentes de `Account`)',
            });
        }
        if (!request.account.institution) {
            throw new PaymentError({
                code: 'invalid_request',
                provider: this.name,
                message: "Hub2 exige l'opérateur (`institution`) pour un encaissement mobile money",
            });
        }

        const existing = await this.findIntent(request.reference);

        if (existing && this.hasAttempt(existing)) {
            // Une tentative est déjà partie sur cette référence. La relancer
            // débiterait le client une seconde fois.
            return this.toResult(existing);
        }

        const intent = existing ?? await this.createIntent(request);
        return this.toResult(await this.attempt(intent, request));
    }

    /**
     * Transmet le code reçu par le client, après une action de type `otp`.
     *
     * Ne concerne QUE l'OTP. Une action `ussd` ou `redirect` se dénoue chez
     * l'opérateur : rien ne remonte par ici, c'est le webhook qui tranche.
     */
    async confirm(reference: string, code: string): Promise<PaymentResult> {
        const intent = await this.findIntent(reference);
        if (!intent) {
            throw new PaymentError({
                code: 'invalid_request',
                provider: this.name,
                message: `Hub2 ne connaît aucun encaissement de référence ${reference}`,
            });
        }
        const id = this.expectId(intent);
        const token = this.expectToken(intent);

        const res = await this.http.request(
            {
                method: 'POST',
                path: `/payment-intents/${encodeURIComponent(id)}/authentication`,
                body: { token, confirmationCode: code },
                // Un OTP se consomme. Le rejouer, c'est le brûler pour rien.
                maxRetries: 0,
            },
            this.name
        );
        return this.toResult(this.expectIntent(res.body));
    }

    /** Retrouve un encaissement par la référence applicative, ou `null`. */
    async fetchByReference(reference: string): Promise<PaymentResult | null> {
        const intent = await this.findIntent(reference);
        return intent ? this.toResult(intent) : null;
    }

    /* -------------------------------------------------------------- *
     * Appels
     * -------------------------------------------------------------- */

    private async createIntent(request: PaymentRequest): Promise<Hub2Intent> {
        const body: Record<string, unknown> = {
            // La référence applicative devient `purchaseReference` : c'est par
            // elle qu'on retrouvera l'intention, y compris après un timeout.
            purchaseReference: request.reference,
            // Obligatoire côté Hub2. À défaut d'un identifiant client fourni, le
            // numéro du payeur est la référence la plus fidèle dont on dispose.
            customerReference: request.metadata?.['customerReference'] ?? request.account.identifier,
            amount: request.amount.amount,
            currency: request.amount.currency,
        };
        if (this.cfg.businessName) body['overrideBusinessName'] = this.cfg.businessName;

        const res = await this.http.request(
            { method: 'POST', path: '/payment-intents', body, maxRetries: 0 },
            this.name
        );
        return this.expectIntent(res.body);
    }

    private async attempt(intent: Hub2Intent, request: PaymentRequest): Promise<Hub2Intent> {
        const id = this.expectId(intent);
        const token = this.expectToken(intent);
        const institution = (request.account.institution ?? '').toLowerCase();

        const mobileMoney: Record<string, unknown> = {
            msisdn: toMsisdn(request.account.identifier),
        };

        // Parcours en une étape : certains intégrateurs collectent l'OTP en même
        // temps que le numéro. Hub2 l'accepte et évite alors l'aller-retour.
        const otp = request.metadata?.['otp'];
        if (otp) mobileMoney['otp'] = otp;

        const urls = this.cfg.redirection;
        if (urls?.onSuccess) mobileMoney['onSuccessRedirectionUrl'] = urls.onSuccess;
        if (urls?.onFailed) mobileMoney['onFailedRedirectionUrl'] = urls.onFailed;
        if (institution === 'orange') {
            if (this.cfg.orangeWorkflow) mobileMoney['workflow'] = this.cfg.orangeWorkflow;
            if (urls?.onCancel) mobileMoney['onCancelRedirectionUrl'] = urls.onCancel;
            if (urls?.onFinish) mobileMoney['onFinishRedirectionUrl'] = urls.onFinish;
        }

        const res = await this.http.request(
            {
                method: 'POST',
                path: `/payment-intents/${encodeURIComponent(id)}/payments`,
                body: {
                    token,
                    paymentMethod: 'mobile_money',
                    country: request.account.country,
                    provider: institution,
                    mobileMoney,
                },
                // Une tentative engage le débit du client. Jamais de rejeu automatique.
                maxRetries: 0,
            },
            this.name
        );
        return this.expectIntent(res.body);
    }

    private async findIntent(reference: string): Promise<Hub2Intent | null> {
        const res = await this.http.request(
            {
                method: 'GET',
                path: `/payment-intents?purchaseReference=${encodeURIComponent(reference)}`,
            },
            this.name
        );
        if (!Array.isArray(res.body)) return null;
        const list = (res.body as unknown[]).filter(
            (i): i is Hub2Intent => typeof i === 'object' && i !== null
        );
        return mostRecent(list);
    }

    /* -------------------------------------------------------------- *
     * Traductions
     * -------------------------------------------------------------- */

    private hasAttempt(intent: Hub2Intent): boolean {
        return Array.isArray(intent.payments) && intent.payments.length > 0;
    }

    private expectIntent(body: unknown): Hub2Intent {
        if (typeof body !== 'object' || body === null) {
            throw new PaymentError({
                code: 'provider_error',
                provider: this.name,
                message: 'Hub2 : réponse d\'encaissement illisible',
            });
        }
        return body as Hub2Intent;
    }

    private expectId(intent: Hub2Intent): string {
        if (typeof intent.id !== 'string' || !intent.id) {
            throw new PaymentError({
                code: 'provider_error',
                provider: this.name,
                message: 'Hub2 : intention sans identifiant',
            });
        }
        return intent.id;
    }

    private expectToken(intent: Hub2Intent): string {
        if (typeof intent.token !== 'string' || !intent.token) {
            throw new PaymentError({
                code: 'provider_error',
                provider: this.name,
                message: 'Hub2 : intention sans jeton — impossible d\'agir dessus',
            });
        }
        return intent.token;
    }

    /** Traduit `nextAction` en consigne exploitable par l'application. */
    private readAction(intent: Hub2Intent): PaymentAction | undefined {
        const next = intent.nextAction;
        if (!next || typeof next !== 'object') return undefined;
        const type = next.type;
        const message = typeof next.message === 'string' ? next.message : '';

        if (type === 'otp') return { type: 'otp', message };
        if (type === 'ussd') return { type: 'ussd', message };
        if (type === 'redirection') {
            const url = next.data?.url;
            // Une redirection sans adresse n'est pas une consigne. On préfère
            // ne rien annoncer plutôt qu'envoyer le client vers le vide : le
            // statut reste `action_required` et le webhook fera foi.
            if (typeof url !== 'string' || !url) return undefined;
            const action: PaymentAction = { type: 'redirect', message, url };
            if (typeof next.data?.method === 'string') action.method = next.data.method;
            if (next.data?.data !== undefined) action.data = next.data.data;
            return action;
        }
        return undefined;
    }

    private readFailure(intent: Hub2Intent, status: PaymentStatus): PaymentError | undefined {
        const cause = intent.lastPaymentFailure;
        const code = cause && typeof cause === 'object' && typeof cause.code === 'string'
            ? cause.code
            : undefined;

        if (code) {
            const options: {
                code: ErrorCode; provider: string; providerCode: string; message?: string;
            } = {
                code: PAYMENT_FAILURE[code] ?? 'unknown',
                provider: this.name,
                providerCode: code,
            };
            // Hub2 précise que ce message est rédigé pour être montré au client.
            if (typeof cause?.message === 'string' && cause.message) options.message = cause.message;
            return new PaymentError(options);
        }

        // `canceled` sans cause détaillée : l'intention a été abandonnée.
        if (status === 'failed' && intent.status === 'canceled') {
            return new PaymentError({
                code: 'customer_declined',
                provider: this.name,
                providerCode: 'canceled',
            });
        }
        return undefined;
    }

    /** Frais de la dernière tentative — les précédentes ont échoué, elles ne coûtent rien. */
    private readFee(intent: Hub2Intent, currency: Currency): Money | undefined {
        if (!Array.isArray(intent.payments)) return undefined;
        const payments = (intent.payments as unknown[]).filter(
            (p): p is Hub2Payment => typeof p === 'object' && p !== null
        );
        const last = mostRecent(payments);
        return last ? sumFees(last.fees, currency) : undefined;
    }

    toResult(intent: Hub2Intent): PaymentResult {
        const raw = intent.status;
        const status = typeof raw === 'string' ? INTENT_STATUS[raw] : undefined;
        if (!status) {
            throw new PaymentError({
                code: 'provider_error',
                provider: this.name,
                message: `Hub2 a renvoyé un statut d'encaissement inconnu : ${String(raw)}`,
            });
        }

        const result: PaymentResult = {
            reference: typeof intent.purchaseReference === 'string' ? intent.purchaseReference : '',
            status,
            raw: intent,
        };

        // L'identifiant de l'INTENTION : c'est lui qui permet de réinterroger,
        // de confirmer un OTP, et de rattacher les webhooks. L'identifiant de la
        // tentative est conservé dans `raw`.
        if (typeof intent.id === 'string') result.providerReference = intent.id;

        if (status === 'action_required') {
            const action = this.readAction(intent);
            if (action) result.action = action;
        }

        if (typeof intent.currency === 'string') {
            const fee = this.readFee(intent, intent.currency as Currency);
            if (fee) result.fee = fee;
        }

        const error = this.readFailure(intent, status);
        if (error) result.error = error;

        return result;
    }
}

/**
 * Statuts des événements `payment_intent.*`, en repli quand l'objet transporté
 * ne porte pas de statut.
 *
 * **Abonne-toi aux événements d'INTENTION, pas de paiement.** Hub2 émet aussi
 * des `payment.*`, mais un objet `Payment` ne contient que `intentId` — jamais
 * `purchaseReference`. Impossible d'y rattacher une référence applicative sans
 * une lecture supplémentaire. Les événements d'intention, eux, couvrent tout le
 * cycle et portent la référence.
 */
export const PAYIN_EVENT_STATUS: Record<string, PaymentStatus | undefined> = {
    'payment_intent.created': 'pending',
    'payment_intent.processing': 'processing',
    'payment_intent.action_required': 'action_required',
    'payment_intent.succeeded': 'succeeded',
    'payment_intent.payment_failed': 'failed',
};
