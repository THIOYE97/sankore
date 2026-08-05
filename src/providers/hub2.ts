/**
 * Hub2 — adaptateur vers l'agrégateur Hub2, dans les deux sens.
 *
 * **Décaissement** (`direction: 'payout'`) : `POST /transfers`. Un ordre —
 * on envoie, ça part.
 *
 * **Encaissement** (`direction: 'payin'`) : une intention de paiement et ses
 * tentatives, déléguées à `Hub2PayIn`. Une demande — il faut qu'une personne
 * compose un code. D'où le statut `action_required` et la méthode `confirm()`.
 *
 * Les deux mécaniques n'ont presque rien en commun côté Hub2 : objets, statuts
 * et causes d'échec sont distincts. Ce fichier porte le décaissement et
 * l'aiguillage ; `hub2-payin.ts` porte l'encaissement ; `hub2-shared.ts` le peu
 * qui est réellement commun.
 *
 * Références (vérifiées le 5 août 2026) :
 *   - OpenAPI    https://api.hub2.io/docs-json  (v2.156.0)
 *   - Intégration https://docs.hub2.io/integration/en/transfers/transfers_integration
 *   - Causes d'échec https://docs.hub2.io/integration/en/transfers/transfers_failure_causes
 *
 * Authentification : trois en-têtes — `ApiKey`, `MerchantId`, `Environment`.
 * Il n'y a pas d'URL de sandbox distincte : c'est l'en-tête `Environment` qui
 * choisit le monde. D'où le défaut à `sandbox` — se tromper d'en-tête ne doit
 * jamais coûter de l'argent réel.
 */

import { Money } from '../core/money.ts';
import type { Currency } from '../core/money.ts';
import { PaymentError } from '../core/errors.ts';
import type { ErrorCode } from '../core/errors.ts';
import type { PaymentStatus } from '../core/status.ts';
import { HttpClient } from '../core/http.ts';
import type {
    PaymentProvider, PaymentRequest, PaymentResult,
    Capability, WebhookEvent, CountryCode, Account, Direction,
} from '../core/provider.ts';
import {
    DEFAULT_BASE_URL, buildCapabilities, buildHttp,
    assertReference, toMsisdn, sumFees, mostRecent,
    type Hub2Options,
} from './hub2-shared.ts';
import { Hub2PayIn, PAYIN_EVENT_STATUS, type Hub2Intent } from './hub2-payin.ts';

export type { Hub2Options, Hub2RedirectionUrls } from './hub2-shared.ts';

/** Les deux sens sont servis par les mêmes corridors mobile money. */
const DEFAULT_CAPABILITIES: readonly Capability[] = buildCapabilities(['payout', 'payin']);

/* ------------------------------------------------------------------ *
 * Correspondances
 * ------------------------------------------------------------------ */

type Hub2Status = 'created' | 'successful' | 'pending' | 'failed';

/**
 * Attention au faux ami : le `pending` de Hub2 signifie « accepté, en cours de
 * traitement » — c'est le `processing` de Sankoré, pas son `pending`.
 * Le `pending` de Sankoré, c'est le `created` de Hub2.
 */
const STATUS: Record<Hub2Status, PaymentStatus> = {
    created: 'pending',
    pending: 'processing',
    successful: 'succeeded',
    failed: 'failed',
};

/**
 * Les 17 causes d'échec de Hub2, traduites dans la taxonomie de Sankoré.
 *
 * `timeout` se traduit par `network_timeout` : non rejouable, à réconcilier.
 * Ici Hub2 a déjà tranché — le virement est `failed` — mais le code conserve
 * la nature de la panne pour le support et les statistiques.
 */
const FAILURE_CAUSE: Record<string, ErrorCode> = {
    insufficient_funds: 'insufficient_funds',
    invalid_destination: 'invalid_account',
    destination_not_allowed: 'account_blocked',
    blacklisted_msisdn: 'account_blocked',
    fraud_suspicion: 'account_blocked',
    forbidden_by_provider: 'account_blocked',
    canceled: 'customer_declined',
    unsupported_currency: 'unsupported_corridor',
    invalid_amount: 'invalid_request',
    bad_request: 'invalid_request',
    invalid_payment_processor: 'invalid_request',
    duplicate_request: 'duplicate_request',
    service_unavailable: 'provider_unavailable',
    too_many_request: 'rate_limited',
    timeout: 'network_timeout',
    internal_error: 'provider_error',
    unknown_reason: 'unknown',
};

/* ------------------------------------------------------------------ *
 * Formes de réponse Hub2 (sous-ensemble utilisé)
 * ------------------------------------------------------------------ */

interface Hub2Transfer {
    id?: unknown;
    reference?: unknown;
    status?: unknown;
    amount?: unknown;
    currency?: unknown;
    createdAt?: unknown;
    providerReference?: unknown;
    fees?: unknown;
    failureCause?: { code?: unknown; message?: unknown } | null;
}

/* ------------------------------------------------------------------ *
 * Adaptateur
 * ------------------------------------------------------------------ */

export class Hub2Provider implements PaymentProvider {
    readonly name: string;
    readonly environment: 'live' | 'sandbox';

    private readonly http: HttpClient;
    private readonly caps: readonly Capability[];
    private readonly businessName?: string;
    private readonly origin?: { name?: string; country?: CountryCode };
    private readonly verifyWebhook?: (rawBody: string, headers: Record<string, string>) => boolean;
    private readonly payin: Hub2PayIn;

    constructor(opts: Hub2Options) {
        if (!opts.apiKey) throw new Error('Hub2 : apiKey manquante');
        if (!opts.merchantId) throw new Error('Hub2 : merchantId manquant');

        this.name = opts.name ?? 'hub2';
        this.environment = opts.environment ?? 'sandbox';
        this.caps = opts.capabilities ?? DEFAULT_CAPABILITIES;
        this.businessName = opts.businessName;
        this.origin = opts.origin;
        this.verifyWebhook = opts.verifyWebhook;

        this.http = buildHttp(opts, this.environment);
        this.payin = new Hub2PayIn(this.http, {
            name: this.name,
            businessName: opts.businessName,
            redirection: opts.redirection,
            orangeWorkflow: opts.orangeWorkflow,
        });
    }

    capabilities(): readonly Capability[] {
        return this.caps;
    }

    /**
     * Interroge `GET /data/providers` et construit les corridors du jour.
     *
     * Endpoint public : aucune authentification, aucun mouvement d'argent.
     * À appeler au démarrage pour ne pas router sur une photo périmée :
     *
     *     const provider = new Hub2Provider({ …, capabilities: await Hub2Provider.fetchCapabilities() });
     */
    static async fetchCapabilities(opts: {
        baseUrl?: string;
        fetchImpl?: typeof fetch;
        /** Sens à déclarer. Les deux par défaut — Hub2 ne les distingue pas dans cette liste. */
        directions?: readonly Direction[];
    } = {}): Promise<readonly Capability[]> {
        const directions = opts.directions ?? (['payout', 'payin'] as const);
        const http = new HttpClient({
            baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
            fetchImpl: opts.fetchImpl,
        });
        const res = await http.request({ method: 'GET', path: '/data/providers' }, 'hub2');
        if (!Array.isArray(res.body)) {
            throw new PaymentError({
                code: 'provider_error',
                provider: 'hub2',
                message: 'Hub2 : /data/providers n\'a pas renvoyé une liste',
            });
        }

        // Regroupe par (pays, devise) : un corridor, plusieurs opérateurs.
        const byCorridor = new Map<string, { country: string; currency: Currency; institutions: string[] }>();
        for (const raw of res.body as unknown[]) {
            if (typeof raw !== 'object' || raw === null) continue;
            const p = raw as Record<string, unknown>;
            if (p['method'] !== 'mobile_money') continue;
            const country = p['country'];
            const currency = p['currency'];
            const institution = p['name'];
            if (typeof country !== 'string' || typeof currency !== 'string' || typeof institution !== 'string') continue;

            const key = `${country}/${currency}`;
            const entry = byCorridor.get(key)
                ?? { country, currency: currency as Currency, institutions: [] };
            // Hub2 renvoie « Orange » ; l'API de virement exige « orange ».
            entry.institutions.push(institution.toLowerCase());
            byCorridor.set(key, entry);
        }

        return buildCapabilities(directions, [...byCorridor.values()]);
    }

    /* -------------------------------------------------------------- *
     * Aiguillage
     * -------------------------------------------------------------- */

    /**
     * Décaisse ou encaisse, selon `request.direction`.
     *
     * Un encaissement peut revenir en `action_required` : ce n'est ni un succès
     * ni un échec, c'est une consigne à transmettre au client. Voir
     * `PaymentResult.action` et `confirm()`.
     */
    async execute(request: PaymentRequest): Promise<PaymentResult> {
        return request.direction === 'payin'
            ? this.payin.collect(request)
            : this.transfer(request);
    }

    /**
     * Transmet le code reçu par le client après une action `otp`.
     *
     * Ne concerne que l'encaissement : un décaissement ne demande rien à personne.
     */
    async confirm(reference: string, code: string): Promise<PaymentResult> {
        return this.payin.confirm(reference, code);
    }

    /* -------------------------------------------------------------- *
     * Décaissement
     * -------------------------------------------------------------- */

    private async transfer(request: PaymentRequest): Promise<PaymentResult> {
        if (!request.amount.isPositive()) {
            throw new PaymentError({
                code: 'invalid_request',
                provider: this.name,
                message: `montant invalide : ${request.amount.toString()}`,
            });
        }
        // Mieux vaut refuser ici que récolter un 400 opaque après coup.
        assertReference(request.reference, this.name);

        const body: Record<string, unknown> = {
            reference: request.reference,
            // Hub2 attend des unités mineures — comme Money. Aucune conversion :
            // « 100 to charge FCFA100, a zero-decimal currency ».
            amount: request.amount.amount,
            currency: request.amount.currency,
            description: request.label ?? request.reference,
            destination: this.toDestination(request.account),
        };
        if (this.businessName) body['overrideBusinessName'] = this.businessName;
        if (this.origin) body['origin'] = this.origin;
        if (request.metadata) body['transferInformation'] = request.metadata;

        let res;
        try {
            res = await this.http.request(
                {
                    method: 'POST',
                    path: '/transfers',
                    body,
                    // JAMAIS de reprise automatique sur une création : un 502 ne
                    // prouve pas que rien n'est parti. C'est la règle du projet.
                    maxRetries: 0,
                },
                this.name
            );
        } catch (err) {
            // Un 409 peut signaler que cette référence existe déjà chez Hub2.
            // On ne le suppose pas : on va voir. Si le virement est là, le
            // rejeu est idempotent et on rend son état réel ; sinon on relaie
            // l'erreur telle quelle.
            if (err instanceof PaymentError && err.code === 'duplicate_request') {
                const existing = await this.findByReference(request.reference);
                if (existing) return this.toResult(existing);
            }
            throw err;
        }

        return this.toResult(this.expectTransfer(res.body));
    }

    /**
     * Interroge l'état réel d'une opération à partir de la référence applicative,
     * quel qu'en soit le sens.
     *
     * C'est la porte de sortie après un timeout. Hub2 indexe par ses propres
     * identifiants (`tr_…`, `pi_…`), mais accepte les filtres `?reference=` et
     * `?purchaseReference=` — on n'a donc pas besoin d'avoir réussi à mémoriser
     * son identifiant pour retrouver l'opération. C'est précisément le cas où
     * l'on en a le plus besoin.
     *
     * La signature ne dit pas le sens : on cherche d'abord côté virements, puis
     * côté encaissements. Deux requêtes au pire, séquentielles — les limites de
     * débit de Hub2 sont assez basses pour qu'on ne les double pas par confort.
     */
    async fetchStatus(reference: string): Promise<PaymentResult> {
        const transfer = await this.findByReference(reference);
        if (transfer) return this.toResult(transfer);

        const collected = await this.payin.fetchByReference(reference);
        if (collected) return collected;

        throw new PaymentError({
            code: 'invalid_request',
            provider: this.name,
            message: `Hub2 ne connaît aucune opération de référence ${reference}`,
        });
    }

    private async findByReference(reference: string): Promise<Hub2Transfer | null> {
        const res = await this.http.request(
            { method: 'GET', path: `/transfers?reference=${encodeURIComponent(reference)}` },
            this.name
        );
        if (!Array.isArray(res.body)) return null;

        // Anomalie si plusieurs : la référence devrait être unique. On retient
        // la plus récente plutôt qu'un élément arbitraire de la liste.
        return mostRecent(
            (res.body as unknown[]).filter(
                (t): t is Hub2Transfer => typeof t === 'object' && t !== null
            )
        );
    }

    /* -------------------------------------------------------------- *
     * Webhooks
     * -------------------------------------------------------------- */

    /**
     * Normalise un événement `transfer.*` (décaissement) ou `payment_intent.*`
     * (encaissement).
     *
     * Les événements `payment.*` sont volontairement ignorés : un objet
     * `Payment` ne porte que `intentId`, jamais la référence applicative. On
     * ne peut pas les rattacher à une opération sans une lecture de plus.
     * Abonne-toi aux événements d'intention, ils couvrent tout le cycle.
     *
     * Passe le **corps brut** (la chaîne reçue) et non un objet déjà parsé : une
     * signature se calcule sur des octets, et `JSON.stringify` ne restitue pas
     * l'ordre des clés d'origine. Si un vérificateur est configuré et qu'on
     * reçoit un objet, on refuse — impossible de vérifier, donc on ne valide pas.
     */
    parseWebhook(payload: unknown, headers: Record<string, string>): WebhookEvent | null {
        let parsed: unknown = payload;

        if (this.verifyWebhook) {
            if (typeof payload !== 'string') return null;
            if (!this.verifyWebhook(payload, headers)) return null;
        }
        if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch { return null; }
        }
        if (typeof parsed !== 'object' || parsed === null) return null;

        const event = parsed as Record<string, unknown>;
        const type = event['type'];
        if (typeof type !== 'string') return null;

        const data = event['data'];
        if (typeof data !== 'object' || data === null) return null;

        if (type.startsWith('transfer.')) return this.transferEvent(type, data, parsed);
        if (type.startsWith('payment_intent.')) return this.payinEvent(type, data, parsed);
        return null;
    }

    private transferEvent(type: string, data: object, raw: unknown): WebhookEvent | null {
        const transfer = data as Hub2Transfer;
        if (typeof transfer.reference !== 'string') return null;

        // Le statut porté par l'objet fait foi ; le type d'événement ne sert
        // que de repli s'il manque.
        const status = this.readStatus(transfer.status) ?? EVENT_STATUS[type];
        if (!status) return null;

        const result: WebhookEvent = { reference: transfer.reference, status, raw };
        if (typeof transfer.id === 'string') result.providerReference = transfer.id;
        const error = this.readFailure(transfer);
        if (error) result.error = error;
        return result;
    }

    private payinEvent(type: string, data: object, raw: unknown): WebhookEvent | null {
        const intent = data as Hub2Intent;
        if (typeof intent.purchaseReference !== 'string') return null;

        // On passe par la traduction de l'encaisseur pour que les statuts, les
        // causes d'échec et les consignes soient lues exactement comme ailleurs.
        let result: PaymentResult;
        try {
            result = this.payin.toResult(intent);
        } catch {
            // Statut absent de l'objet : on retombe sur le type d'événement.
            const status = PAYIN_EVENT_STATUS[type];
            if (!status) return null;
            return { reference: intent.purchaseReference, status, raw };
        }

        const event: WebhookEvent = {
            reference: result.reference,
            status: result.status,
            raw,
        };
        if (result.providerReference) event.providerReference = result.providerReference;
        if (result.error) event.error = result.error;
        return event;
    }

    /* -------------------------------------------------------------- *
     * Solde
     * -------------------------------------------------------------- */

    /** Solde disponible du compte de virement, dans la devise demandée. */
    async balance(currency: Currency, _country?: CountryCode): Promise<Money> {
        const res = await this.http.request(
            { method: 'GET', path: `/balance?currency=${encodeURIComponent(currency)}` },
            this.name
        );
        if (typeof res.body !== 'object' || res.body === null) {
            throw new PaymentError({
                code: 'provider_error', provider: this.name,
                message: 'Hub2 : réponse de solde illisible',
            });
        }

        const accounts = (res.body as Record<string, unknown>)['transferAccount'];
        if (!Array.isArray(accounts)) {
            throw new PaymentError({
                code: 'provider_error', provider: this.name,
                message: 'Hub2 : aucun compte de virement dans la réponse de solde',
            });
        }

        let total = Money.zero(currency);
        let matched = false;
        for (const raw of accounts as unknown[]) {
            if (typeof raw !== 'object' || raw === null) continue;
            const account = raw as Record<string, unknown>;
            if (account['currency'] !== currency) continue;
            const amount = account['availableBalance'];
            if (typeof amount !== 'number' || !Number.isInteger(amount)) continue;
            total = total.add(Money.minor(amount, currency));
            matched = true;
        }

        if (!matched) {
            throw new PaymentError({
                code: 'invalid_request', provider: this.name,
                message: `Hub2 : aucun compte de virement en ${currency}`,
            });
        }
        return total;
    }

    /* -------------------------------------------------------------- *
     * Traductions internes
     * -------------------------------------------------------------- */

    private toDestination(account: Account): Record<string, unknown> {
        if (account.rail === 'mobile_money') {
            if (!account.institution) {
                throw new PaymentError({
                    code: 'invalid_request',
                    provider: this.name,
                    message: "Hub2 exige l'opérateur (`institution`) pour un virement mobile money",
                });
            }
            const destination: Record<string, unknown> = {
                type: 'mobile_money',
                country: account.country,
                msisdn: toMsisdn(account.identifier),
                // Hub2 impose l'opérateur en minuscules.
                provider: account.institution.toLowerCase(),
            };
            if (account.holderName) destination['recipientName'] = account.holderName;
            return destination;
        }

        if (account.rail === 'bank') {
            // Hub2 réclame le code banque et un numéro de bénéficiaire, deux
            // champs qui n'existent pas dans `Account`. Ils transitent donc par
            // `metadata`, faute de quoi la requête part incomplète.
            throw new PaymentError({
                code: 'unsupported_corridor',
                provider: this.name,
                message: "Hub2 : le virement bancaire exige `bankCode` et `beneficiaryPhone`, "
                    + 'non encore exposés par cet adaptateur',
            });
        }

        throw new PaymentError({
            code: 'unsupported_corridor',
            provider: this.name,
            message: `Hub2 ne couvre pas le rail « ${account.rail} » en décaissement`,
        });
    }

    private expectTransfer(body: unknown): Hub2Transfer {
        if (typeof body !== 'object' || body === null) {
            throw new PaymentError({
                code: 'provider_error',
                provider: this.name,
                message: 'Hub2 : réponse de virement illisible',
            });
        }
        return body as Hub2Transfer;
    }

    private readStatus(value: unknown): PaymentStatus | undefined {
        if (typeof value !== 'string') return undefined;
        return STATUS[value as Hub2Status];
    }

    private readFailure(transfer: Hub2Transfer): PaymentError | undefined {
        const cause = transfer.failureCause;
        if (!cause || typeof cause !== 'object') return undefined;
        const code = typeof cause.code === 'string' ? cause.code : undefined;
        if (!code) return undefined;

        const options: {
            code: ErrorCode; provider: string; providerCode: string; message?: string;
        } = {
            code: FAILURE_CAUSE[code] ?? 'unknown',
            provider: this.name,
            providerCode: code,
        };
        if (typeof cause.message === 'string' && cause.message) options.message = cause.message;
        return new PaymentError(options);
    }

    private toResult(transfer: Hub2Transfer): PaymentResult {
        const status = this.readStatus(transfer.status);
        if (!status) {
            throw new PaymentError({
                code: 'provider_error',
                provider: this.name,
                message: `Hub2 a renvoyé un statut inconnu : ${String(transfer.status)}`,
            });
        }

        const result: PaymentResult = {
            reference: typeof transfer.reference === 'string' ? transfer.reference : '',
            status,
            raw: transfer,
        };
        // `id` (tr_…) et non `providerReference` : c'est cet identifiant qui
        // permet de réinterroger Hub2. Le `providerReference` de Hub2 est celui
        // de l'opérateur en bout de chaîne, conservé dans `raw`.
        if (typeof transfer.id === 'string') result.providerReference = transfer.id;

        if (typeof transfer.currency === 'string') {
            const fee = sumFees(transfer.fees, transfer.currency as Currency);
            if (fee) result.fee = fee;
        }
        const error = this.readFailure(transfer);
        if (error) result.error = error;
        return result;
    }
}

/** Repli quand l'objet transporté par le webhook ne porte pas de statut. */
const EVENT_STATUS: Record<string, PaymentStatus | undefined> = {
    'transfer.created': 'pending',
    'transfer.processing': 'processing',
    'transfer.succeeded': 'succeeded',
    'transfer.failed': 'failed',
};
