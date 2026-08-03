/**
 * Idempotence — la garantie qu'une même opération ne part jamais deux fois.
 *
 * Scénario réel : le client tape deux fois sur « Envoyer », ou le réseau coupe
 * après l'appel et l'application rejoue. Sans verrou, deux virements partent.
 * En transfert d'argent, c'est la faute la plus coûteuse qui soit.
 *
 * Le store est une interface : en développement, la version mémoire suffit ;
 * en production il faut Redis ou PostgreSQL, car le verrou doit être partagé
 * entre tous les processus.
 */

import type { PaymentResult } from './provider.ts';

export interface IdempotencyRecord {
    key: string;
    /** `in_flight` : un appel est en cours. `completed` : résultat disponible. */
    state: 'in_flight' | 'completed';
    result?: PaymentResult;
    createdAt: number;
}

export interface IdempotencyStore {
    /**
     * Réserve la clé de façon atomique.
     * Retourne `null` si la réservation réussit (la voie est libre),
     * ou l'enregistrement existant si la clé est déjà prise.
     */
    reserve(key: string, ttlMs: number): Promise<IdempotencyRecord | null>;
    complete(key: string, result: PaymentResult): Promise<void>;
    release(key: string): Promise<void>;
    get(key: string): Promise<IdempotencyRecord | null>;
}

export class DuplicateInFlightError extends Error {
    readonly key: string;
    constructor(key: string) {
        super(`opération déjà en cours pour la clé ${key}`);
        this.name = 'DuplicateInFlightError';
        this.key = key;
    }
}

/** Store mémoire — développement et tests UNIQUEMENT. Ne protège qu'un seul processus. */
export class MemoryIdempotencyStore implements IdempotencyStore {
    private readonly map = new Map<string, IdempotencyRecord>();

    private purge(key: string, ttlMs: number): void {
        const rec = this.map.get(key);
        if (rec && Date.now() - rec.createdAt > ttlMs) this.map.delete(key);
    }

    async reserve(key: string, ttlMs: number): Promise<IdempotencyRecord | null> {
        this.purge(key, ttlMs);
        const existing = this.map.get(key);
        if (existing) return existing;
        this.map.set(key, { key, state: 'in_flight', createdAt: Date.now() });
        return null;
    }

    async complete(key: string, result: PaymentResult): Promise<void> {
        const rec = this.map.get(key);
        this.map.set(key, {
            key,
            state: 'completed',
            result,
            createdAt: rec?.createdAt ?? Date.now(),
        });
    }

    async release(key: string): Promise<void> {
        this.map.delete(key);
    }

    async get(key: string): Promise<IdempotencyRecord | null> {
        return this.map.get(key) ?? null;
    }
}

export interface IdempotencyOptions {
    store: IdempotencyStore;
    /** Durée de rétention d'une clé. 24 h par défaut. */
    ttlMs?: number;
}

/**
 * Exécute `fn` au plus une fois par clé.
 *
 * - clé libre        -> exécution, puis mémorisation du résultat
 * - clé terminée     -> renvoi du résultat mémorisé, sans réexécuter
 * - clé en cours     -> `DuplicateInFlightError` (surtout ne pas exécuter en parallèle)
 *
 * En cas d'échec de `fn`, la clé est libérée : une panne ne doit pas bloquer
 * définitivement une référence légitime.
 */
export async function withIdempotency(
    key: string,
    opts: IdempotencyOptions,
    fn: () => Promise<PaymentResult>
): Promise<PaymentResult> {
    const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    const existing = await opts.store.reserve(key, ttlMs);

    if (existing) {
        if (existing.state === 'completed' && existing.result) return existing.result;
        throw new DuplicateInFlightError(key);
    }

    try {
        const result = await fn();
        await opts.store.complete(key, result);
        return result;
    } catch (err) {
        await opts.store.release(key);
        throw err;
    }
}
