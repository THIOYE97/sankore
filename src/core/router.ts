/**
 * Routeur — choisit le fournisseur capable de traiter une opération, et porte
 * les garanties qui ne doivent pas dépendre de la vigilance de l'appelant.
 *
 * C'est le cœur de la valeur : dans un corridor ouest-africain, plusieurs
 * agrégateurs couvrent le même pays avec des frais, des plafonds et des taux
 * de disponibilité différents. Le routeur encapsule ce choix pour que
 * l'application n'ait jamais à le connaître.
 *
 * Trois garanties y sont rattachées, parce qu'une garantie qu'il faut penser à
 * activer n'est pas une garantie :
 *
 * - **Idempotence.** Avec un `IdempotencyStore`, `execute()` ne part jamais
 *   deux fois sur la même référence. Sans store, le comportement reste celui
 *   d'avant — mais une application en production qui n'en fournit pas accepte
 *   sciemment le double paiement.
 * - **Disjoncteur.** Un fournisseur qui enchaîne les pannes est écarté sans
 *   appel réseau, le temps qu'il se relève.
 * - **Observabilité.** Chaque décision de routage et chaque issue sont
 *   observables, sans que l'application instrumente quoi que ce soit.
 *
 * Le repli en cascade est délibérément OPTIONNEL et limité aux erreurs
 * strictement rejouables : basculer de fournisseur après un timeout serait
 * le meilleur moyen de payer deux fois.
 */

import type { PaymentProvider, PaymentRequest, PaymentResult, Capability, Rail, CountryCode, Direction } from './provider.ts';
import type { Currency } from './money.ts';
import { PaymentError } from './errors.ts';
import { isFinal } from './status.ts';
import { BreakerRegistry, type BreakerOptions } from './breaker.ts';
import { safeObserver, type Observer } from './observability.ts';
import { withIdempotency, type IdempotencyStore } from './idempotency.ts';

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

/** Réglage de l'idempotence au niveau du routeur. */
export interface RouterIdempotency {
    store: IdempotencyStore;
    /** Durée de rétention d'une clé. 24 h par défaut. */
    ttlMs?: number;
    /**
     * Construit la clé à partir de la requête. `request.reference` par défaut.
     *
     * À surcharger en multi-locataires : deux clients peuvent légitimement
     * employer la référence `CMD-1`. Sans préfixe de locataire, le second verrait
     * le résultat du premier — un paiement attribué au mauvais compte, ce qui
     * est pire qu'un doublon.
     */
    keyFor?: (request: PaymentRequest) => string;
}

export interface RouterOptions {
    /** Ordre de préférence par défaut, du plus au moins prioritaire. */
    preference?: readonly string[];
    rank?: RankFn;
    /** Autorise le repli sur le fournisseur suivant. Faux par défaut : le silence vaut mieux qu'un double paiement. */
    failover?: boolean;
    /** Active l'idempotence sur `execute()`. Vivement recommandé en production. */
    idempotency?: RouterIdempotency;
    /**
     * Active les disjoncteurs par fournisseur.
     *
     * `true` prend les réglages par défaut (5 échecs, réouverture à 30 s) ;
     * un objet les précise ; l'absence les désactive.
     */
    breaker?: boolean | BreakerOptions;
    observer?: Observer;
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
    private readonly idempotency?: RouterIdempotency;
    private readonly breakers?: BreakerRegistry;
    private readonly observe: Observer;

    constructor(providers: readonly PaymentProvider[] = [], opts: RouterOptions = {}) {
        this.providers = [...providers];
        this.preference = opts.preference ?? [];
        if (opts.rank) this.rank = opts.rank;
        this.failover = opts.failover ?? false;
        if (opts.idempotency) this.idempotency = opts.idempotency;
        this.observe = safeObserver(opts.observer);

        if (opts.breaker) {
            const breakerOpts: BreakerOptions = opts.breaker === true ? {} : { ...opts.breaker };
            if (!breakerOpts.observer && opts.observer) breakerOpts.observer = opts.observer;
            this.breakers = new BreakerRegistry(breakerOpts);
        }
    }

    register(provider: PaymentProvider): this {
        if (this.providers.some((p) => p.name === provider.name)) {
            throw new Error(`fournisseur déjà enregistré : ${provider.name}`);
        }
        this.providers.push(provider);
        return this;
    }

    /** Un fournisseur par son nom — indispensable pour réconcilier une opération passée. */
    provider(name: string): PaymentProvider | null {
        return this.providers.find((p) => p.name === name) ?? null;
    }

    /** Tous les fournisseurs enregistrés. */
    all(): readonly PaymentProvider[] {
        return [...this.providers];
    }

    /**
     * Tous les fournisseurs éligibles, du plus au moins prioritaire.
     *
     * Les fournisseurs dont le disjoncteur est ouvert sont RELÉGUÉS, pas
     * retirés : si tous sont en panne, mieux vaut tenter le moins mal portant
     * que répondre « corridor non couvert » — une réponse qui enverrait
     * l'exploitation chercher un problème de configuration inexistant.
     */
    candidates(query: RouteQuery): PaymentProvider[] {
        const eligible = this.providers.filter((p) => p.capabilities().some((c) => matches(c, query)));

        return eligible.sort((a, b) => {
            if (this.breakers) {
                const da = this.breakers.for(a.name).allows() ? 0 : 1;
                const db = this.breakers.for(b.name).allows() ? 0 : 1;
                if (da !== db) return da - db;
            }
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
     * Santé des fournisseurs — à exposer sur une sonde `/health`.
     *
     * Vide si les disjoncteurs ne sont pas activés : il n'y a alors rien à
     * raconter, et prétendre le contraire serait pire que se taire.
     */
    health(): { provider: string; state: string; failures: number; retryAt: number }[] {
        return this.breakers?.snapshot() ?? [];
    }

    private queryFor(request: PaymentRequest): RouteQuery {
        const query: RouteQuery = {
            rail: request.account.rail,
            country: request.account.country,
            currency: request.amount.currency,
            direction: request.direction,
            amount: request.amount.amount,
        };
        if (request.account.institution) query.institution = request.account.institution;
        return query;
    }

    /**
     * Exécute une opération via le fournisseur retenu.
     *
     * Protégée par l'idempotence si un store a été fourni : une même référence
     * ne part qu'une fois, un rejeu rend le résultat mémorisé, et un rejeu après
     * une issue incertaine est REFUSÉ au profit d'une réconciliation.
     *
     * Avec `failover: true`, bascule sur le suivant UNIQUEMENT si l'erreur est
     * marquée rejouable — c'est-à-dire s'il est certain que rien n'a été engagé
     * en face. Un timeout n'est jamais rejouable : il déclenche une
     * réconciliation, pas un second appel.
     */
    async execute(request: PaymentRequest): Promise<PaymentResult> {
        const idem = this.idempotency;
        if (!idem) return this.dispatch(request);

        const key = idem.keyFor ? idem.keyFor(request) : request.reference;
        const options: Parameters<typeof withIdempotency>[1] = {
            store: idem.store,
            reference: request.reference,
            observer: this.observe,
        };
        if (idem.ttlMs !== undefined) options.ttlMs = idem.ttlMs;

        return withIdempotency(key, options, () => this.dispatch(request));
    }

    /** Le routage proprement dit, hors idempotence. */
    private async dispatch(request: PaymentRequest): Promise<PaymentResult> {
        const query = this.queryFor(request);
        const list = this.candidates(query);

        if (list.length === 0) {
            this.observe({
                kind: 'payment.unroutable',
                at: Date.now(),
                reference: request.reference,
                code: 'unsupported_corridor',
                detail: {
                    rail: query.rail, country: query.country,
                    currency: query.currency, direction: query.direction,
                },
            });
            throw new PaymentError({
                code: 'unsupported_corridor',
                message: `aucun fournisseur pour ${query.rail}/${query.country}/${query.currency}/${query.direction}`,
            });
        }

        let lastError: unknown;
        for (const [index, provider] of list.entries()) {
            const started = Date.now();
            this.observe({
                kind: 'payment.routed',
                at: started,
                provider: provider.name,
                reference: request.reference,
                attempt: index + 1,
                detail: {
                    rail: query.rail, country: query.country, currency: query.currency,
                    direction: query.direction, amount: query.amount,
                    candidates: list.length,
                },
            });

            try {
                const breaker = this.breakers?.for(provider.name);
                const result = breaker
                    ? await breaker.run(() => provider.execute(request))
                    : await provider.execute(request);

                this.observeResult(provider.name, result, Date.now() - started);
                return result;
            } catch (err) {
                lastError = err;
                const retryable = err instanceof PaymentError && err.retryable;
                const code = err instanceof PaymentError ? err.code : 'unknown';

                this.observe({
                    kind: 'payment.failed',
                    at: Date.now(),
                    provider: provider.name,
                    reference: request.reference,
                    code,
                    durationMs: Date.now() - started,
                    detail: {
                        thrown: true,
                        retryable,
                        needsReconciliation: err instanceof PaymentError && err.needsReconciliation,
                    },
                });

                if (!this.failover || !retryable) throw err;

                const next = list[index + 1];
                if (next) {
                    this.observe({
                        kind: 'payment.failover',
                        at: Date.now(),
                        provider: next.name,
                        reference: request.reference,
                        code,
                        detail: { from: provider.name },
                    });
                }
                // sinon : on tente le fournisseur suivant
            }
        }
        throw lastError;
    }

    /**
     * Distingue les trois issues d'un résultat rendu sans exception.
     *
     * Un `failed` renvoyé dans un `PaymentResult` n'est pas la même chose qu'un
     * `PaymentError` levé : le premier est un refus que le fournisseur a su
     * formuler, le second une panne. Les confondre dans les tableaux de bord
     * conduit à alerter l'astreinte sur des soldes insuffisants.
     */
    private observeResult(provider: string, result: PaymentResult, durationMs: number): void {
        const kind = result.status === 'succeeded'
            ? 'payment.succeeded'
            : result.status === 'failed'
                ? 'payment.failed'
                : 'payment.pending';

        const observation: Parameters<Observer>[0] = {
            kind,
            at: Date.now(),
            provider,
            reference: result.reference,
            paymentStatus: result.status,
            durationMs,
            detail: {
                thrown: false,
                final: isFinal(result.status),
                action: result.action?.type,
                providerReference: result.providerReference,
            },
        };
        if (result.error) {
            observation.code = result.error.code;
            if (result.error.providerCode) observation.providerCode = result.error.providerCode;
        }
        this.observe(observation);
    }
}
