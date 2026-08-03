/**
 * Routeur — choisit le fournisseur capable de traiter une opération.
 *
 * C'est le cœur de la valeur : dans un corridor ouest-africain, plusieurs
 * agrégateurs couvrent le même pays avec des frais, des plafonds et des taux
 * de disponibilité différents. Le routeur encapsule ce choix pour que
 * l'application n'ait jamais à le connaître.
 *
 * Le repli en cascade est délibérément OPTIONNEL et limité aux erreurs
 * strictement rejouables : basculer de fournisseur après un timeout serait
 * le meilleur moyen de payer deux fois.
 */

import type { PaymentProvider, PaymentRequest, PaymentResult, Capability, Rail, CountryCode, Direction } from './provider.ts';
import type { Currency } from './money.ts';
import { PaymentError } from './errors.ts';

export interface RouteQuery {
    rail: Rail;
    country: CountryCode;
    currency: Currency;
    direction: Direction;
    /** Montant en unités mineures, pour filtrer sur les plafonds. */
    amount: number;
    institution?: string;
}

/** Départage plusieurs fournisseurs éligibles. Score le plus BAS = préféré. */
export type RankFn = (provider: PaymentProvider, query: RouteQuery) => number;

export interface RouterOptions {
    /** Ordre de préférence par défaut, du plus au moins prioritaire. */
    preference?: readonly string[];
    rank?: RankFn;
    /** Autorise le repli sur le fournisseur suivant. Faux par défaut : le silence vaut mieux qu'un double paiement. */
    failover?: boolean;
}

function matches(cap: Capability, q: RouteQuery): boolean {
    if (cap.rail !== q.rail) return false;
    if (cap.country !== q.country) return false;
    if (cap.currency !== q.currency) return false;
    if (cap.direction !== q.direction) return false;
    if (cap.minAmount !== undefined && q.amount < cap.minAmount) return false;
    if (cap.maxAmount !== undefined && q.amount > cap.maxAmount) return false;
    if (q.institution && cap.institutions && !cap.institutions.includes(q.institution)) return false;
    return true;
}

export class Router {
    private readonly providers: PaymentProvider[] = [];
    private readonly preference: readonly string[];
    private readonly rank?: RankFn;
    private readonly failover: boolean;

    constructor(providers: readonly PaymentProvider[] = [], opts: RouterOptions = {}) {
        this.providers = [...providers];
        this.preference = opts.preference ?? [];
        this.rank = opts.rank;
        this.failover = opts.failover ?? false;
    }

    register(provider: PaymentProvider): this {
        if (this.providers.some((p) => p.name === provider.name)) {
            throw new Error(`fournisseur déjà enregistré : ${provider.name}`);
        }
        this.providers.push(provider);
        return this;
    }

    /** Tous les fournisseurs éligibles, du plus au moins prioritaire. */
    candidates(query: RouteQuery): PaymentProvider[] {
        const eligible = this.providers.filter((p) => p.capabilities().some((c) => matches(c, query)));

        return eligible.sort((a, b) => {
            if (this.rank) {
                const d = this.rank(a, query) - this.rank(b, query);
                if (d !== 0) return d;
            }
            const ia = this.preference.indexOf(a.name);
            const ib = this.preference.indexOf(b.name);
            const na = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
            const nb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
            if (na !== nb) return na - nb;
            return a.name.localeCompare(b.name);
        });
    }

    /** Le meilleur fournisseur, ou `null` si le corridor n'est pas couvert. */
    resolve(query: RouteQuery): PaymentProvider | null {
        return this.candidates(query)[0] ?? null;
    }

    /** Corridors servis, utile pour exposer une page « pays couverts ». */
    corridors(): Capability[] {
        return this.providers.flatMap((p) => [...p.capabilities()]);
    }

    /**
     * Exécute une opération via le fournisseur retenu.
     *
     * Avec `failover: true`, bascule sur le suivant UNIQUEMENT si l'erreur est
     * marquée rejouable — c'est-à-dire s'il est certain que rien n'a été engagé
     * en face. Un timeout n'est jamais rejouable : il déclenche une
     * réconciliation, pas un second appel.
     */
    async execute(request: PaymentRequest): Promise<PaymentResult> {
        const query: RouteQuery = {
            rail: request.account.rail,
            country: request.account.country,
            currency: request.amount.currency,
            direction: request.direction,
            amount: request.amount.amount,
            institution: request.account.institution,
        };

        const list = this.candidates(query);
        if (list.length === 0) {
            throw new PaymentError({
                code: 'unsupported_corridor',
                message: `aucun fournisseur pour ${query.rail}/${query.country}/${query.currency}/${query.direction}`,
            });
        }

        let lastError: unknown;
        for (const provider of list) {
            try {
                return await provider.execute(request);
            } catch (err) {
                lastError = err;
                const retryable = err instanceof PaymentError && err.retryable;
                if (!this.failover || !retryable) throw err;
                // sinon : on tente le fournisseur suivant
            }
        }
        throw lastError;
    }
}
