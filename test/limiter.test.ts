import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/core/limiter.ts';
import { PaymentError } from '../src/core/errors.ts';

/**
 * Horloge et attente simulées : l'attente AVANCE l'horloge au lieu de
 * suspendre. Un test de limiteur qui dort réellement est un test qu'on
 * désactive six mois plus tard parce que la CI est trop lente.
 */
function fakeTime(start = 1_000_000) {
    let t = start;
    return {
        now: () => t,
        sleep: async (ms: number) => { t += ms; },
        advance: (ms: number) => { t += ms; },
        get t() { return t; },
    };
}

describe('Limiteur — rafale et régime permanent', () => {
    test('la rafale passe immédiatement', async () => {
        const time = fakeTime();
        const l = new RateLimiter({ ratePerSecond: 2, burst: 5, now: time.now, sleep: time.sleep });

        const avant = time.t;
        for (let i = 0; i < 5; i++) await l.acquire();
        assert.equal(time.t, avant, 'cinq jetons disponibles : aucune attente');
        assert.equal(l.available(), 0);
    });

    test('au-delà de la rafale, la cadence est imposée', async () => {
        const time = fakeTime();
        const l = new RateLimiter({ ratePerSecond: 10, burst: 1, now: time.now, sleep: time.sleep });

        await l.acquire();                 // consomme le seul jeton
        const avant = time.t;
        await l.acquire();                 // doit attendre ~100 ms
        assert.ok(time.t - avant >= 100, `attente observée : ${time.t - avant} ms`);
    });

    test('tryAcquire ne bloque jamais et dit la vérité', async () => {
        const time = fakeTime();
        const l = new RateLimiter({ ratePerSecond: 1, burst: 1, now: time.now, sleep: time.sleep });

        assert.equal(l.tryAcquire(), true);
        assert.equal(l.tryAcquire(), false);

        time.advance(1_000);
        assert.equal(l.tryAcquire(), true);
    });

    test('le seau se regarnit avec le temps, sans dépasser la rafale', () => {
        const time = fakeTime();
        const l = new RateLimiter({ ratePerSecond: 5, burst: 3, now: time.now, sleep: time.sleep });

        assert.equal(l.tryAcquire(), true);
        assert.equal(l.tryAcquire(), true);
        assert.equal(l.tryAcquire(), true);

        time.advance(60_000);
        assert.equal(l.available(), 3, 'le seau ne déborde pas');
    });
});

describe('Limiteur — ordre et équité', () => {
    test('la file est servie dans l’ordre d’arrivée', async () => {
        const time = fakeTime();
        const l = new RateLimiter({ ratePerSecond: 100, burst: 1, now: time.now, sleep: time.sleep });

        await l.acquire();                 // vide le seau

        const ordre: number[] = [];
        const attentes = [0, 1, 2, 3, 4].map((i) =>
            l.acquire().then(() => { ordre.push(i); })
        );

        await Promise.all(attentes);
        assert.deepEqual(ordre, [0, 1, 2, 3, 4], 'sans FIFO, les premiers arrivés affament');
    });

    test('tryAcquire ne vole pas la place des requêtes en file', async () => {
        const time = fakeTime();
        const l = new RateLimiter({ ratePerSecond: 100, burst: 1, now: time.now, sleep: time.sleep });

        await l.acquire();
        const enAttente = l.acquire();
        assert.equal(l.pending(), 1);
        assert.equal(l.tryAcquire(), false, 'quelqu’un attend déjà : on ne passe pas devant');

        await enAttente;
    });
});

describe('Limiteur — renoncer plutôt que retenir trop longtemps', () => {
    test('une attente au-delà du plafond est refusée immédiatement', async () => {
        const time = fakeTime();
        const l = new RateLimiter({
            ratePerSecond: 1, burst: 1, maxWaitMs: 500, now: time.now, sleep: time.sleep,
        });

        await l.acquire();
        await assert.rejects(
            () => l.acquire(),
            (e: PaymentError) => e.code === 'rate_limited' && e.retryable
        );
        assert.equal(l.pending(), 0, 'le refus ne laisse rien en file');
    });

    test('l’annulation libère la place', async () => {
        const time = fakeTime();
        const l = new RateLimiter({
            ratePerSecond: 1, burst: 1, maxWaitMs: 60_000, now: time.now, sleep: time.sleep,
        });

        await l.acquire();
        const controller = new AbortController();
        const attente = l.acquire({ signal: controller.signal });
        assert.equal(l.pending(), 1);

        controller.abort();
        await assert.rejects(attente, (e: PaymentError) => e.code === 'rate_limited');
        assert.equal(l.pending(), 0);
    });

    test('un signal déjà annulé est refusé sans entrer en file', async () => {
        const time = fakeTime();
        const l = new RateLimiter({ ratePerSecond: 1, burst: 1, now: time.now, sleep: time.sleep });
        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
            () => l.acquire({ signal: controller.signal }),
            (e: PaymentError) => e.code === 'rate_limited'
        );
    });

    test('une cadence nulle ou négative est refusée à la construction', () => {
        assert.throws(() => new RateLimiter({ ratePerSecond: 0 }));
        assert.throws(() => new RateLimiter({ ratePerSecond: -1 }));
    });
});

describe('Limiteur — observabilité', () => {
    test('la mise en attente et le refus sont observables', async () => {
        const time = fakeTime();
        const vus: { kind: string; rejected?: unknown }[] = [];
        const l = new RateLimiter({
            ratePerSecond: 1, burst: 1, maxWaitMs: 500, now: time.now, sleep: time.sleep,
            observer: (o) => vus.push({ kind: o.kind, rejected: o.detail?.['rejected'] }),
        });

        await l.acquire();
        await assert.rejects(() => l.acquire());

        assert.equal(vus.length, 1);
        assert.equal(vus[0]?.kind, 'http.throttled');
        assert.equal(vus[0]?.rejected, true);
    });
});
