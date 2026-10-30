/**
 * Disjoncteur — cesser d'appeler un fournisseur qui ne répond plus.
 *
 * Le scénario qu'il évite est banal et coûteux. Un agrégateur tombe. Chaque
 * paiement part quand même, attend quinze secondes, échoue. Les requêtes
 * s'empilent, le pool de connexions sature, les files d'attente débordent — et
 * la panne d'un fournisseur devient la panne de la plateforme entière. Un
 * paiement qui échoue en deux millisecondes avec un message clair vaut
 * infiniment mieux que mille paiements qui agonisent en parallèle.
 *
 * Trois états, selon le schéma classique :
 *
 *   fermé      -> les requêtes passent. On compte les échecs consécutifs.
 *   ouvert     -> plus rien ne part. Refus immédiat, sans appel réseau.
 *   semi-ouvert-> une seule requête d'essai est autorisée. Elle tranche :
 *                 succès -> fermé ; échec -> ouvert à nouveau, plus longtemps.
 *
 * **Ce qui est propre au paiement.** Tous les échecs ne disent pas la même
 * chose de la santé d'un fournisseur. Un solde insuffisant est une réponse
 * parfaitement saine : le fournisseur a fait son travail. Ouvrir le disjoncteur
 * là-dessus écarterait un agrégateur en pleine forme parce que trois clients
 * de suite sont à découvert. Seuls les signaux de santé comptent — voir
 * `HEALTH_SIGNALS`.
 *
 * **Pourquoi c'est sûr.** Un refus de disjoncteur intervient AVANT tout appel
 * réseau : rien n'a été engagé en face, et l'erreur est donc légitimement
 * rejouable — c'est le seul endroit du projet où rejouer est sans risque par
 * construction.
 */

import { PaymentError } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { safeObserver, type Observer } from './observability.ts';

/**
 * Codes d'erreur qui renseignent sur la SANTÉ du fournisseur.
 *
 * `authentication_failed` en est volontairement absent : des identifiants
 * invalides font échouer chaque appel, le disjoncteur s'ouvrirait aussitôt et
 * masquerait la vraie cause derrière un « service indisponible ». Une erreur de
 * configuration doit rester bruyante jusqu'à sa correction.
 *
 * `rate_limited` en fait partie : les limites de débit des agrégateurs
 * ouest-africains sont basses, et le bon réflexe face à un 429 est de se taire
 * un moment, pas d'insister.
 */
export const HEALTH_SIGNALS: readonly ErrorCode[] = [
    'provider_unavailable',
    'network_timeout',
    'rate_limited',
    'provider_error',
];

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
    /** Échecs de santé consécutifs avant ouverture. 5 par défaut. */
    failureThreshold?: number;
    /** Durée d'ouverture avant le premier essai. 30 s par défaut. */
    resetMs?: number;
    /**
     * Multiplicateur appliqué à la durée d'ouverture après un essai manqué.
     * 2 par défaut : 30 s, 60 s, 120 s… Une panne d'opérateur se compte souvent
     * en heures ; insister toutes les trente secondes ne fait que remplir les
     * journaux.
     */
    backoffFactor?: number;
    /** Plafond de la durée d'ouverture. 5 min par défaut. */
    maxResetMs?: number;
    observer?: Observer;
    /** Horloge injectable — rend les tests déterministes, sans attente réelle. */
    now?: () => number;
}

/**
 * Disjoncteur pour UN fournisseur.
 *
 * Instance par fournisseur et par processus. En multi-processus, chaque
 * instance apprend la panne pour son compte : c'est volontaire. Partager
 * l'état via Redis ajouterait une dépendance réseau sur le chemin critique
 * d'un paiement — exactement ce qu'un disjoncteur est censé protéger.
 */
export class CircuitBreaker {
    readonly provider: string;

    private readonly failureThreshold: number;
    private readonly resetMs: number;
    private readonly backoffFactor: number;
    private readonly maxResetMs: number;
    private readonly observe: Observer;
    private readonly now: () => number;

    private state: BreakerState = 'closed';
    private failures = 0;
    private openedAt = 0;
    private currentResetMs: number;
    /** Un seul essai à la fois en semi-ouvert — sinon la volée entière repart. */
    private trialInFlight = false;

    constructor(provider: string, opts: BreakerOptions = {}) {
        this.provider = provider;
        this.failureThreshold = opts.failureThreshold ?? 5;
        this.resetMs = opts.resetMs ?? 30_000;
        this.backoffFactor = opts.backoffFactor ?? 2;
        this.maxResetMs = opts.maxResetMs ?? 300_000;
        this.observe = safeObserver(opts.observer);
        this.now = opts.now ?? Date.now;
        this.currentResetMs = this.resetMs;
    }

    /** État courant, après prise en compte du temps écoulé. */
    current(): BreakerState {
        this.maybeHalfOpen();
        return this.state;
    }

    /** Vrai si une requête serait acceptée maintenant. */
    allows(): boolean {
        const state = this.current();
        if (state === 'closed') return true;
        if (state === 'open') return false;
        return !this.trialInFlight;
    }

    /** Instant à partir duquel un nouvel essai sera tenté. 0 si le circuit est fermé. */
    retryAt(): number {
        return this.state === 'open' ? this.openedAt + this.currentResetMs : 0;
    }

    private maybeHalfOpen(): void {
        if (this.state !== 'open') return;
        if (this.now() - this.openedAt < this.currentResetMs) return;
        this.state = 'half_open';
        this.trialInFlight = false;
        this.observe({
            kind: 'breaker.half_open',
            at: this.now(),
            provider: this.provider,
            detail: { afterMs: this.currentResetMs },
        });
    }

    /**
     * Exécute `fn` sous la protection du disjoncteur.
     *
     * Lève sans rien appeler si le circuit est ouvert. L'erreur porte le code
     * `provider_unavailable` — rejouable, puisque rien n'est parti.
     */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (!this.allows()) {
            const waitMs = Math.max(0, this.retryAt() - this.now());
            this.observe({
                kind: 'breaker.rejected',
                at: this.now(),
                provider: this.provider,
                detail: { waitMs, failures: this.failures },
            });
            throw new PaymentError({
                code: 'provider_unavailable',
                provider: this.provider,
                message: `${this.provider} est écarté par le disjoncteur `
                    + `(${this.failures} échecs consécutifs) — nouvel essai dans ${waitMs} ms`,
            });
        }

        const trial = this.state === 'half_open';
        if (trial) this.trialInFlight = true;

        try {
            const out = await fn();
            this.onSuccess();
            return out;
        } catch (err) {
            this.onError(err);
            throw err;
        } finally {
            if (trial) this.trialInFlight = false;
        }
    }

    /** À appeler après une opération réussie. Referme un circuit en essai. */
    onSuccess(): void {
        this.failures = 0;
        if (this.state !== 'closed') {
            this.state = 'closed';
            this.currentResetMs = this.resetMs;
            this.observe({ kind: 'breaker.closed', at: this.now(), provider: this.provider });
        }
    }

    /**
     * À appeler après un échec. N'ouvre le circuit que si l'erreur renseigne sur
     * la santé du fournisseur — un refus métier laisse le compteur intact.
     */
    onError(err: unknown): void {
        const code = err instanceof PaymentError ? err.code : 'unknown';
        if (!HEALTH_SIGNALS.includes(code)) {
            // Réponse saine d'un fournisseur en bonne santé : on ne compte rien,
            // et un essai en semi-ouvert est même considéré comme concluant.
            if (this.state === 'half_open') this.onSuccess();
            return;
        }

        this.failures += 1;

        if (this.state === 'half_open') {
            // L'essai a échoué : on rouvre, plus longtemps.
            this.currentResetMs = Math.min(this.currentResetMs * this.backoffFactor, this.maxResetMs);
            this.open(code);
            return;
        }

        if (this.state === 'closed' && this.failures >= this.failureThreshold) {
            this.open(code);
        }
    }

    private open(code: ErrorCode): void {
        this.state = 'open';
        this.openedAt = this.now();
        this.observe({
            kind: 'breaker.opened',
            at: this.openedAt,
            provider: this.provider,
            code,
            detail: { failures: this.failures, reopenInMs: this.currentResetMs },
        });
    }

    /** Remet le disjoncteur à neuf — exploitation manuelle, et tests. */
    reset(): void {
        this.state = 'closed';
        this.failures = 0;
        this.openedAt = 0;
        this.currentResetMs = this.resetMs;
        this.trialInFlight = false;
    }

    /** Photographie de l'état, pour une sonde de santé applicative. */
    snapshot(): { provider: string; state: BreakerState; failures: number; retryAt: number } {
        return {
            provider: this.provider,
            state: this.current(),
            failures: this.failures,
            retryAt: this.retryAt(),
        };
    }
}

/**
 * Un disjoncteur par fournisseur, créés à la demande.
 *
 * C'est ce que le routeur consulte : la santé se mesure par fournisseur, pas
 * globalement. Orange Mali qui tombe ne doit pas écarter Wave Sénégal.
 */
export class BreakerRegistry {
    private readonly breakers = new Map<string, CircuitBreaker>();
    private readonly opts: BreakerOptions;

    constructor(opts: BreakerOptions = {}) {
        this.opts = opts;
    }

    for(provider: string): CircuitBreaker {
        const existing = this.breakers.get(provider);
        if (existing) return existing;
        const created = new CircuitBreaker(provider, this.opts);
        this.breakers.set(provider, created);
        return created;
    }

    /** Tous les états connus — à exposer sur `/health` ou `/readyz`. */
    snapshot(): ReturnType<CircuitBreaker['snapshot']>[] {
        return [...this.breakers.values()].map((b) => b.snapshot());
    }

    resetAll(): void {
        for (const b of this.breakers.values()) b.reset();
    }
}
