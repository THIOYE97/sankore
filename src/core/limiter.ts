/**
 * Limiteur de débit — tenir la cadence que le fournisseur accepte.
 *
 * Les agrégateurs ouest-africains plafonnent bas, et pas toujours de façon
 * documentée. Dépasser la limite ne coûte pas qu'un 429 : certains opérateurs
 * suspendent la clé d'API, d'autres mettent en file silencieusement et
 * répondent trente secondes plus tard. Dans les deux cas, c'est la plateforme
 * qui tombe — pour avoir été trop pressée.
 *
 * Mieux vaut donc retenir la requête CHEZ NOUS, où l'attente est mesurable et
 * annulable, que la laisser partir et subir la sanction. Une rafale lissée
 * passe ; la même rafale brutale fait sauter la clé.
 *
 * **Seau à jetons, servi en FIFO.** Le seau autorise une rafale (`burst`) puis
 * impose le régime permanent (`ratePerSecond`). La file est ordonnée : sans
 * cela, sous charge soutenue, les requêtes arrivées en premier attendraient
 * indéfiniment pendant que les nouvelles se serviraient — une famine que
 * personne ne diagnostique avant d'avoir perdu des paiements.
 *
 * **Pourquoi renoncer est sûr.** Un refus du limiteur intervient avant tout
 * appel réseau : rien n'est engagé en face, l'erreur `rate_limited` est donc
 * légitimement rejouable.
 */

import { PaymentError } from './errors.ts';
import { safeObserver, type Observer } from './observability.ts';

export interface RateLimiterOptions {
    /** Requêtes par seconde en régime permanent. */
    ratePerSecond: number;
    /**
     * Taille de la rafale autorisée. Égale à `ratePerSecond` par défaut.
     * Monter cette valeur laisse passer un pic court sans l'étaler.
     */
    burst?: number;
    /**
     * Attente maximale acceptée avant de renoncer. 10 s par défaut.
     *
     * Ce plafond n'est pas un détail de confort : sans lui, une file saturée
     * retient des paiements plus longtemps que le délai d'attente HTTP, et
     * l'appelant voit un timeout dont la cause réelle est chez lui.
     */
    maxWaitMs?: number;
    observer?: Observer;
    /** Horloge injectable — tests déterministes, sans attente réelle. */
    now?: () => number;
    /** Attente injectable, pour la même raison. */
    sleep?: (ms: number) => Promise<void>;
}

interface Waiter {
    resolve: () => void;
    reject: (err: unknown) => void;
    /** Désabonnement du signal d'annulation, s'il y en avait un. */
    detach?: () => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimiter {
    private readonly rate: number;
    private readonly burst: number;
    private readonly maxWaitMs: number;
    private readonly observe: Observer;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    private tokens: number;
    private lastRefill: number;
    private readonly queue: Waiter[] = [];
    private pumping = false;

    constructor(opts: RateLimiterOptions) {
        if (!(opts.ratePerSecond > 0)) {
            throw new Error(`ratePerSecond doit être strictement positif (reçu : ${opts.ratePerSecond})`);
        }
        this.rate = opts.ratePerSecond;
        this.burst = Math.max(1, opts.burst ?? Math.ceil(opts.ratePerSecond));
        this.maxWaitMs = opts.maxWaitMs ?? 10_000;
        this.observe = safeObserver(opts.observer);
        this.now = opts.now ?? Date.now;
        this.sleep = opts.sleep ?? defaultSleep;

        this.tokens = this.burst;
        this.lastRefill = this.now();
    }

    private refill(): void {
        const now = this.now();
        const elapsed = now - this.lastRefill;
        if (elapsed <= 0) return;
        this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.rate);
        this.lastRefill = now;
    }

    /** L'erreur d'annulation — rejouable, puisque rien n'est parti. */
    private cancelled(provider: string | undefined): PaymentError {
        const options: { code: 'rate_limited'; message: string; provider?: string } = {
            code: 'rate_limited',
            message: 'attente du limiteur de débit annulée',
        };
        if (provider !== undefined) options.provider = provider;
        return new PaymentError(options);
    }

    /** Consomme un jeton s'il y en a un de libre, sans jamais attendre. */
    tryAcquire(): boolean {
        this.refill();
        if (this.queue.length > 0 || this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }

    /** Jetons immédiatement disponibles — diagnostic et tests. */
    available(): number {
        this.refill();
        return Math.floor(this.tokens);
    }

    /** Requêtes en attente de jeton. */
    pending(): number {
        return this.queue.length;
    }

    /**
     * Attend un jeton.
     *
     * Lève `rate_limited` si l'attente estimée dépasse `maxWaitMs`, ou si le
     * signal d'annulation est déclenché. Dans les deux cas rien n'est parti.
     */
    async acquire(opts: { signal?: AbortSignal; provider?: string } = {}): Promise<void> {
        if (opts.signal?.aborted) throw this.cancelled(opts.provider);

        if (this.tryAcquire()) return;

        // Attente estimée : les requêtes déjà en file passent avant celle-ci.
        const needed = this.queue.length + 1 - this.tokens;
        const waitMs = Math.max(0, (needed / this.rate) * 1000);

        if (waitMs > this.maxWaitMs) {
            this.observe({
                kind: 'http.throttled',
                at: this.now(),
                provider: opts.provider,
                code: 'rate_limited',
                detail: { waitMs: Math.round(waitMs), maxWaitMs: this.maxWaitMs, queued: this.queue.length, rejected: true },
            });
            const saturated: { code: 'rate_limited'; message: string; provider?: string } = {
                code: 'rate_limited',
                message: `limiteur de débit saturé : ${Math.round(waitMs)} ms d'attente estimée, `
                    + `au-delà du plafond de ${this.maxWaitMs} ms`,
            };
            if (opts.provider !== undefined) saturated.provider = opts.provider;
            throw new PaymentError(saturated);
        }

        this.observe({
            kind: 'http.throttled',
            at: this.now(),
            provider: opts.provider,
            detail: { waitMs: Math.round(waitMs), queued: this.queue.length, rejected: false },
        });

        await new Promise<void>((resolve, reject) => {
            const waiter: Waiter = { resolve, reject };

            const signal = opts.signal;
            if (signal) {
                const onAbort = () => {
                    const i = this.queue.indexOf(waiter);
                    if (i !== -1) this.queue.splice(i, 1);
                    reject(this.cancelled(opts.provider));
                };
                signal.addEventListener('abort', onAbort, { once: true });
                waiter.detach = () => signal.removeEventListener('abort', onAbort);
            }

            this.queue.push(waiter);
            void this.pump();
        });
    }

    /**
     * Sert la file dans l'ordre d'arrivée.
     *
     * Une seule pompe tourne à la fois : deux pompes concurrentes
     * distribueraient le même jeton deux fois, et le limiteur ne limiterait
     * plus rien.
     */
    private async pump(): Promise<void> {
        if (this.pumping) return;
        this.pumping = true;
        try {
            while (this.queue.length > 0) {
                this.refill();

                while (this.tokens >= 1 && this.queue.length > 0) {
                    const waiter = this.queue.shift();
                    if (!waiter) break;
                    this.tokens -= 1;
                    waiter.detach?.();
                    waiter.resolve();
                }

                if (this.queue.length === 0) break;

                // Temps exact jusqu'au prochain jeton entier.
                const deficit = 1 - this.tokens;
                const delay = Math.max(1, Math.ceil((deficit / this.rate) * 1000));
                await this.sleep(delay);
            }
        } finally {
            this.pumping = false;
            // Un abandon survenu pendant l'attente a pu vider puis regarnir la
            // file : on relance si quelqu'un attend encore.
            if (this.queue.length > 0) void this.pump();
        }
    }
}
