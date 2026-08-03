import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/core/router.ts';
import { Money } from '../src/core/money.ts';
import { PaymentError } from '../src/core/errors.ts';
import { withIdempotency, MemoryIdempotencyStore, DuplicateInFlightError } from '../src/core/idempotency.ts';
import type { PaymentProvider, PaymentRequest, PaymentResult, Capability } from '../src/core/provider.ts';

/** Fournisseur en bouchon, paramétrable — sert de modèle aux vrais. */
function fakeProvider(
    name: string,
    caps: readonly Capability[],
    behaviour: (req: PaymentRequest) => Promise<PaymentResult> = async (req) => ({
        reference: req.reference,
        status: 'succeeded',
        providerReference: `${name}-001`,
    })
): PaymentProvider {
    return {
        name,
        capabilities: () => caps,
        execute: behaviour,
        fetchStatus: async (reference) => ({ reference, status: 'succeeded' }),
        parseWebhook: () => null,
    };
}

const MOBILE_ML: Capability = {
    rail: 'mobile_money', country: 'ML', currency: 'XOF', direction: 'payout',
    minAmount: 500, maxAmount: 2_000_000,
};

describe('Router — sélection du corridor', () => {
    test('trouve le fournisseur du bon corridor', () => {
        const r = new Router([fakeProvider('bizao', [MOBILE_ML])]);
        const p = r.resolve({ rail: 'mobile_money', country: 'ML', currency: 'XOF', direction: 'payout', amount: 10_000 });
        assert.equal(p?.name, 'bizao');
    });

    test('rend null sur un corridor non couvert', () => {
        const r = new Router([fakeProvider('bizao', [MOBILE_ML])]);
        assert.equal(r.resolve({ rail: 'mobile_money', country: 'SN', currency: 'XOF', direction: 'payout', amount: 10_000 }), null);
    });

    test('respecte les plafonds de l’opérateur', () => {
        const r = new Router([fakeProvider('bizao', [MOBILE_ML])]);
        const base = { rail: 'mobile_money', country: 'ML', currency: 'XOF', direction: 'payout' } as const;
        assert.equal(r.resolve({ ...base, amount: 100 }), null, 'sous le minimum');
        assert.equal(r.resolve({ ...base, amount: 9_000_000 }), null, 'au-dessus du plafond');
        assert.ok(r.resolve({ ...base, amount: 50_000 }), 'dans les bornes');
    });

    test('l’ordre de préférence départage', () => {
        const r = new Router(
            [fakeProvider('cher', [MOBILE_ML]), fakeProvider('moinscher', [MOBILE_ML])],
            { preference: ['moinscher', 'cher'] }
        );
        assert.equal(r.resolve({ rail: 'mobile_money', country: 'ML', currency: 'XOF', direction: 'payout', amount: 10_000 })?.name, 'moinscher');
    });

    test('la microfinance est un rail de première classe', () => {
        const mfi: Capability = { rail: 'mfi', country: 'ML', currency: 'XOF', direction: 'payout' };
        const r = new Router([fakeProvider('kafo', [mfi])]);
        assert.equal(r.resolve({ rail: 'mfi', country: 'ML', currency: 'XOF', direction: 'payout', amount: 5_000 })?.name, 'kafo');
    });
});

describe('Router — sécurité du repli', () => {
    const req: PaymentRequest = {
        reference: 'REF-1',
        direction: 'payout',
        amount: Money.minor(10_000, 'XOF'),
        account: { rail: 'mobile_money', country: 'ML', identifier: '22370000000' },
    };

    test('corridor inconnu -> erreur explicite', async () => {
        const r = new Router([]);
        await assert.rejects(() => r.execute(req), (e: PaymentError) => e.code === 'unsupported_corridor');
    });

    test('SANS failover, aucune bascule silencieuse', async () => {
        const boom = fakeProvider('a', [MOBILE_ML], async () => {
            throw new PaymentError({ code: 'provider_unavailable' });
        });
        let secondAppele = false;
        const ok = fakeProvider('b', [MOBILE_ML], async (rq) => {
            secondAppele = true;
            return { reference: rq.reference, status: 'succeeded' };
        });
        const r = new Router([boom, ok], { preference: ['a', 'b'] });
        await assert.rejects(() => r.execute(req));
        assert.equal(secondAppele, false, 'le second ne doit PAS être appelé sans failover');
    });

    test('AVEC failover, bascule sur erreur rejouable', async () => {
        const boom = fakeProvider('a', [MOBILE_ML], async () => {
            throw new PaymentError({ code: 'provider_unavailable' });
        });
        const ok = fakeProvider('b', [MOBILE_ML]);
        const r = new Router([boom, ok], { preference: ['a', 'b'], failover: true });
        const res = await r.execute(req);
        assert.equal(res.status, 'succeeded');
    });

    test('un TIMEOUT ne déclenche JAMAIS de bascule — risque de double paiement', async () => {
        const boom = fakeProvider('a', [MOBILE_ML], async () => {
            throw new PaymentError({ code: 'network_timeout' });
        });
        let secondAppele = false;
        const ok = fakeProvider('b', [MOBILE_ML], async (rq) => {
            secondAppele = true;
            return { reference: rq.reference, status: 'succeeded' };
        });
        const r = new Router([boom, ok], { preference: ['a', 'b'], failover: true });
        await assert.rejects(() => r.execute(req));
        assert.equal(secondAppele, false, 'un timeout ne dit rien sur ce qui est parti en face');
    });
});

describe('Idempotence — jamais deux fois', () => {
    test('le second appel rend le résultat mémorisé sans réexécuter', async () => {
        const store = new MemoryIdempotencyStore();
        let appels = 0;
        const run = () =>
            withIdempotency('REF-1', { store }, async () => {
                appels++;
                return { reference: 'REF-1', status: 'succeeded' as const };
            });

        const a = await run();
        const b = await run();
        assert.equal(appels, 1, 'la fonction ne doit tourner qu’une fois');
        assert.deepEqual(a, b);
    });

    test('un appel concurrent est refusé, pas dupliqué', async () => {
        const store = new MemoryIdempotencyStore();
        let resoudre: (v: PaymentResult) => void = () => {};
        const enCours = withIdempotency('REF-2', { store }, () => new Promise<PaymentResult>((res) => { resoudre = res; }));

        await assert.rejects(
            () => withIdempotency('REF-2', { store }, async () => ({ reference: 'REF-2', status: 'succeeded' })),
            DuplicateInFlightError
        );

        resoudre({ reference: 'REF-2', status: 'succeeded' });
        await enCours;
    });

    test('un échec libère la clé — une panne ne bloque pas une référence', async () => {
        const store = new MemoryIdempotencyStore();
        await assert.rejects(() =>
            withIdempotency('REF-3', { store }, async () => { throw new Error('panne réseau'); })
        );
        const res = await withIdempotency('REF-3', { store }, async () => ({ reference: 'REF-3', status: 'succeeded' as const }));
        assert.equal(res.status, 'succeeded');
    });
});
