/**
 * SandboxProvider — un fournisseur complet qui ne parle à personne.
 *
 * Il implémente réellement le contrat `PaymentProvider` et conserve un état :
 * `fetchStatus` renvoie ce qui s'est vraiment passé, les webhooks se rejouent,
 * les transitions sont gardées comme en production.
 *
 * Deux usages :
 *   - tests d'intégration, sans réseau ni identifiants ;
 *   - démonstration commerciale : montrer un paiement qui réussit, un qui
 *     échoue et un timeout réconcilié, de façon reproductible.
 *
 * Le comportement est DÉTERMINISTE : aucun tirage aléatoire. Une démo qui
 * se déroule différemment à chaque exécution n'est pas une démo.
 */

import { Money } from '../core/money.ts';
import type { Currency } from '../core/money.ts';
import { PaymentError } from '../core/errors.ts';
import type { ErrorCode } from '../core/errors.ts';
import { transition } from '../core/status.ts';
import type { PaymentStatus } from '../core/status.ts';
import type {
    PaymentProvider, PaymentRequest, PaymentResult,
    Capability, WebhookEvent, CountryCode,
} from '../core/provider.ts';

/** Ce que le simulateur doit faire pour un compte donné. */
export type Scenario =
    | { kind: 'succeed'; feeRate?: number }
    | { kind: 'pending_then_succeed' }   // reste `processing` jusqu'au webhook
    | { kind: 'fail'; code: ErrorCode }
    | { kind: 'timeout' };               // lève network_timeout — à réconcilier

export interface SandboxOptions {
    name?: string;
    capabilities?: readonly Capability[];
    /** Comportement par identifiant de compte. Le reste tombe sur `defaultScenario`. */
    scenarios?: Record<string, Scenario>;
    defaultScenario?: Scenario;
    /** Frais simulés, en fraction du montant. 1,5 % par défaut. */
    feeRate?: number;
    /** Secret de signature des webhooks simulés. */
    webhookSecret?: string;
}

const DEFAULT_CAPS: readonly Capability[] = [
    { rail: 'mobile_money', country: 'ML', currency: 'XOF', direction: 'payout', minAmount: 500, maxAmount: 2_000_000 },
    { rail: 'mobile_money', country: 'ML', currency: 'XOF', direction: 'payin', minAmount: 500, maxAmount: 1_000_000 },
    { rail: 'mobile_money', country: 'CI', currency: 'XOF', direction: 'payout', minAmount: 500, maxAmount: 2_000_000 },
    { rail: 'mobile_money', country: 'SN', currency: 'XOF', direction: 'payout', minAmount: 500, maxAmount: 2_000_000 },
    { rail: 'mfi', country: 'ML', currency: 'XOF', direction: 'payout', minAmount: 1_000, maxAmount: 5_000_000 },
    { rail: 'bank', country: 'ML', currency: 'XOF', direction: 'payout', minAmount: 10_000 },
];

interface Record_ {
    reference: string;
    status: PaymentStatus;
    providerReference: string;
    fee?: Money;
    error?: PaymentError;
}

export class SandboxProvider implements PaymentProvider {
    readonly name: string;
    private readonly caps: readonly Capability[];
    private readonly scenarios: Record<string, Scenario>;
    private readonly defaultScenario: Scenario;
    private readonly feeRate: number;
    private readonly store = new Map<string, Record_>();
    private counter = 0;

    constructor(opts: SandboxOptions = {}) {
        this.name = opts.name ?? 'sandbox';
        this.caps = opts.capabilities ?? DEFAULT_CAPS;
        this.scenarios = opts.scenarios ?? {};
        this.defaultScenario = opts.defaultScenario ?? { kind: 'succeed' };
        this.feeRate = opts.feeRate ?? 0.015;
    }

    capabilities(): readonly Capability[] {
        return this.caps;
    }

    private scenarioFor(identifier: string): Scenario {
        return this.scenarios[identifier] ?? this.defaultScenario;
    }

    private nextRef(): string {
        this.counter += 1;
        return `${this.name.toUpperCase()}-${String(this.counter).padStart(6, '0')}`;
    }

    async execute(request: PaymentRequest): Promise<PaymentResult> {
        // Idempotence interne : rejouer la même référence ne recrée rien.
        const known = this.store.get(request.reference);
        if (known) return this.toResult(known);

        const scenario = this.scenarioFor(request.account.identifier);
        const providerReference = this.nextRef();

        if (scenario.kind === 'timeout') {
            // On enregistre AVANT de lever : c'est tout l'intérêt du cas.
            // Le paiement est bel et bien parti côté fournisseur, l'appelant
            // ne le sait pas. `fetchStatus` révélera la vérité.
            this.store.set(request.reference, {
                reference: request.reference,
                status: 'processing',
                providerReference,
            });
            throw new PaymentError({
                code: 'network_timeout',
                provider: this.name,
                message: `${this.name} n'a pas répondu — statut à vérifier`,
            });
        }

        if (scenario.kind === 'fail') {
            const error = new PaymentError({ code: scenario.code, provider: this.name });
            const rec: Record_ = {
                reference: request.reference,
                status: 'failed',
                providerReference,
                error,
            };
            this.store.set(request.reference, rec);
            return this.toResult(rec);
        }

        const rate = scenario.kind === 'succeed' ? (scenario.feeRate ?? this.feeRate) : this.feeRate;
        const fee = request.amount.multiply(rate, 'ceil');

        const rec: Record_ = {
            reference: request.reference,
            status: scenario.kind === 'succeed' ? 'succeeded' : 'processing',
            providerReference,
            fee,
        };
        this.store.set(request.reference, rec);
        return this.toResult(rec);
    }

    async fetchStatus(reference: string): Promise<PaymentResult> {
        const rec = this.store.get(reference);
        if (!rec) {
            throw new PaymentError({
                code: 'not_found',
                provider: this.name,
                message: `référence inconnue : ${reference}`,
            });
        }
        return this.toResult(rec);
    }

    /**
     * Fait avancer un paiement `processing` — simule le webhook de l'opérateur.
     * Passe par `transition()` : les mêmes règles qu'en production s'appliquent.
     */
    settle(reference: string, to: PaymentStatus = 'succeeded'): WebhookEvent {
        const rec = this.store.get(reference);
        if (!rec) throw new Error(`référence inconnue : ${reference}`);
        rec.status = transition(rec.status, to);
        this.store.set(reference, rec);
        return {
            reference,
            providerReference: rec.providerReference,
            status: rec.status,
            raw: { simulated: true, reference, status: rec.status },
        };
    }

    parseWebhook(payload: unknown, _headers: Record<string, string>): WebhookEvent | null {
        if (typeof payload !== 'object' || payload === null) return null;
        const p = payload as Record<string, unknown>;
        if (typeof p['reference'] !== 'string' || typeof p['status'] !== 'string') return null;

        const event: WebhookEvent = {
            reference: p['reference'],
            status: p['status'] as PaymentStatus,
            raw: payload,
        };
        if (typeof p['providerReference'] === 'string') event.providerReference = p['providerReference'];
        return event;
    }

    async balance(currency: Currency, _country?: CountryCode): Promise<Money> {
        return Money.minor(50_000_000, currency);
    }

    private toResult(rec: Record_): PaymentResult {
        const result: PaymentResult = {
            reference: rec.reference,
            status: rec.status,
            providerReference: rec.providerReference,
            raw: { simulated: true },
        };
        if (rec.fee) result.fee = rec.fee;
        if (rec.error) result.error = rec.error;
        return result;
    }
}
