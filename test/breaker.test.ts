import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, BreakerRegistry } from '../src/core/breaker.ts';
import { PaymentError } from '../src/core/errors.ts';
import type { ErrorCode } from '../src/core/errors.ts';
import type { Observation } from '../src/core/observability.ts';

/** Horloge manuelle : aucun test n’attend réellement. */
function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const fail = (code: ErrorCode) => async (): Promise<never> => {
    throw new PaymentError({ code });
};

describe('Disjoncteur — ouverture', () => {
    test('reste fermé sous le seuil', async () => {
        const c = clock();
        const b = new CircuitBreaker('hub2', { failureThreshold: 3, now: c.now });

        for (let i = 0; i < 2; i++) {
            await assert.rejects(() => b.run(fail('provider_unavailable')));
        }
        assert.equal(b.current(), 'closed');
        assert.equal(b.allows(), true);
    });

    test('s’ouvre au seuil et refuse SANS appel réseau', async () => {
        const c = clock();
        const b = new CircuitBreaker('hub2', { failureThreshold: 3, now: c.now });

        for (let i = 0; i < 3; i++) {
            await assert.rejects(() => b.run(fail('provider_unavailable')));
        }
        assert.equal(b.current(), 'open');

        let appele = false;
        await assert.rejects(
            () => b.run(async () => { appele = true; return 1; }),
            (e: PaymentError) => e.code === 'provider_unavailable' && e.retryable
        );
        assert.equal(appele, false, 'rien ne doit partir quand le circuit est ouvert');
    });

    test('un refus métier ne compte PAS — un solde insuffisant est une réponse saine', async () => {
        const c = clock();
        const b = new CircuitBreaker('hub2', { failureThreshold: 2, now: c.now });

        for (let i = 0; i < 10; i++) {
            await assert.rejects(() => b.run(fail('insufficient_funds')));
        }
        assert.equal(b.current(), 'closed', 'dix clients à découvert ne sont pas une panne');
    });

    test('une erreur de configuration ne masque pas sa cause derrière le disjoncteur', async () => {
        const c = clock();
        const b = new CircuitBreaker('hub2', { failureThreshold: 2, now: c.now });

        for (let i = 0; i < 5; i++) {
            await assert.rejects(() => b.run(async () => {
                throw new PaymentError({ code: 'authentication_failed' });
            }));
        }
        assert.equal(b.current(), 'closed', 'des identifiants invalides doivent rester bruyants');
    });

    test('un succès remet le compteur à zéro', async () => {
        const c = clock();
        const b = new CircuitBreaker('hub2', { failureThreshold: 3, now: c.now });

        await assert.rejects(() => b.run(fail('network_timeout')));
        await assert.rejects(() => b.run(fail('network_timeout')));
        await b.run(async () => 'ok');
        await assert.rejects(() => b.run(fail('network_timeout')));
        await assert.rejects(() => b.run(fail('network_timeout')));
        assert.equal(b.current(), 'closed');
    });
});

describe('Disjoncteur — rétablissement', () => {
    test('passe en semi-ouvert après le délai, puis se referme sur un succès', async () => {
        const c = clock();
        const b = new CircuitBreaker('hub2', { failureThreshold: 1, resetMs: 30_000, now: c.now });

        await assert.rejects(() => b.run(fail('provider_unavailable')));
        assert.equal(b.current(), 'open');

        c.advance(29_999);
        assert.equal(b.current(), 'open');

        c.advance(1);
        assert.equal(b.current(), 'half_open');

        await b.run(async () => 'rétabli');
        assert.equal(b.current(), 'closed');
    });

    test('un essai manqué rouvre plus longtemps', async () => {
        const c = clock();
        const b = new CircuitBreaker('hub2', {
            failureThreshold: 1, resetMs: 10_000, backoffFactor: 2, now: c.now,
        });

        await assert.rejects(() => b.run(fail('provider_unavailable')));
        c.advance(10_000);
        assert.equal(b.current(), 'half_open');

        await assert.rejects(() => b.run(fail('provider_unavailable')));
        assert.equal(b.current(), 'open');

        // La fenêtre a doublé : 10 s ne suffisent plus.
        c.advance(10_000);
        assert.equal(b.current(), 'open');
        c.advance(10_000);
        assert.equal(b.current(), 'half_open');
    });

    test('la fenêtre d’ouverture est plafonnée', async () => {
        const c = clock();
        const b = new CircuitBreaker('hub2', {
            failureThreshold: 1, resetMs: 1_000, backoffFactor: 10, maxResetMs: 5_000, now: c.now,
        });

        for (let i = 0; i < 5; i++) {
            await assert.rejects(() => b.run(fail('provider_unavailable')));
            c.advance(100_000);
        }
        const snap = b.snapshot();
        assert.ok(snap.retryAt - c.now() <= 5_000);
    });

    test('un refus métier pendant l’essai referme le circuit — le fournisseur répond', async () => {
        const c = clock();
        const b = new CircuitBreaker('hub2', { failureThreshold: 1, resetMs: 1_000, now: c.now });

        await assert.rejects(() => b.run(fail('provider_unavailable')));
        c.advance(1_000);
        assert.equal(b.current(), 'half_open');

        await assert.rejects(() => b.run(fail('insufficient_funds')));
        assert.equal(b.current(), 'closed', 'un refus formulé prouve que le fournisseur est debout');
    });

    test('reset() remet tout à neuf', async () => {
        const c = clock();
        const b = new CircuitBreaker('hub2', { failureThreshold: 1, now: c.now });
        await assert.rejects(() => b.run(fail('provider_unavailable')));
        assert.equal(b.current(), 'open');
        b.reset();
        assert.equal(b.current(), 'closed');
    });
});

describe('Disjoncteur — observabilité', () => {
    test('l’ouverture, l’essai et la fermeture sont observables', async () => {
        const c = clock();
        const vus: Observation[] = [];
        const b = new CircuitBreaker('hub2', {
            failureThreshold: 1, resetMs: 1_000, now: c.now, observer: (o) => vus.push(o),
        });

        await assert.rejects(() => b.run(fail('provider_unavailable')));
        await assert.rejects(() => b.run(async () => 1));   // refus sans appel
        c.advance(1_000);
        await b.run(async () => 'ok');

        const kinds = vus.map((o) => o.kind);
        assert.deepEqual(kinds, [
            'breaker.opened', 'breaker.rejected', 'breaker.half_open', 'breaker.closed',
        ]);
        assert.equal(vus[0]?.provider, 'hub2');
    });
});

describe('Registre — la santé se mesure par fournisseur', () => {
    test('chaque fournisseur a son propre disjoncteur', async () => {
        const c = clock();
        const reg = new BreakerRegistry({ failureThreshold: 1, now: c.now });

        await assert.rejects(() => reg.for('orange-ml').run(fail('provider_unavailable')));

        assert.equal(reg.for('orange-ml').current(), 'open');
        assert.equal(reg.for('wave-sn').current(), 'closed', 'Orange Mali ne doit pas écarter Wave Sénégal');
    });

    test('le même nom rend la même instance', () => {
        const reg = new BreakerRegistry();
        assert.equal(reg.for('hub2'), reg.for('hub2'));
    });

    test('la photographie expose chaque état', async () => {
        const c = clock();
        const reg = new BreakerRegistry({ failureThreshold: 1, now: c.now });
        await assert.rejects(() => reg.for('a').run(fail('provider_unavailable')));
        reg.for('b');

        const snap = reg.snapshot();
        assert.equal(snap.length, 2);
        assert.equal(snap.find((s) => s.provider === 'a')?.state, 'open');
        assert.equal(snap.find((s) => s.provider === 'b')?.state, 'closed');
    });
});
