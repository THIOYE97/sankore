import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SandboxProvider } from '../src/providers/sandbox.ts';
import { Money } from '../src/core/money.ts';
import { PaymentError } from '../src/core/errors.ts';
import { StatusTransitionError } from '../src/core/status.ts';
import type { PaymentRequest } from '../src/core/provider.ts';

const req = (ref: string, id: string, montant = 25_000): PaymentRequest => ({
    reference: ref,
    direction: 'payout',
    amount: Money.major(montant, 'XOF'),
    account: { rail: 'mobile_money', country: 'ML', identifier: id },
});

function provider() {
    return new SandboxProvider({
        name: 'test-op',
        scenarios: {
            ok: { kind: 'succeed' },
            solde: { kind: 'fail', code: 'insufficient_funds' },
            lent: { kind: 'timeout' },
            attente: { kind: 'pending_then_succeed' },
        },
    });
}

describe('SandboxProvider — scénarios', () => {
    test('succès avec frais calculés', async () => {
        const r = await provider().execute(req('P1', 'ok'));
        assert.equal(r.status, 'succeeded');
        assert.ok(r.providerReference);
        assert.equal(r.fee?.amount, 375); // 1,5 % de 25 000, arrondi au supérieur
    });

    test('échec avec code normalisé et message client', async () => {
        const r = await provider().execute(req('P2', 'solde'));
        assert.equal(r.status, 'failed');
        assert.equal(r.error?.code, 'insufficient_funds');
        assert.equal(r.error?.retryable, false);
        assert.match(r.error?.customerMessage() ?? '', /[Ss]olde/);
    });

    test('déterministe : deux exécutions donnent le même résultat', async () => {
        const a = await provider().execute(req('P3', 'ok'));
        const b = await provider().execute(req('P3', 'ok'));
        assert.equal(a.providerReference, b.providerReference);
    });
});

describe('SandboxProvider — le cas du timeout', () => {
    test('lève network_timeout, non rejouable et à réconcilier', async () => {
        await assert.rejects(
            () => provider().execute(req('P4', 'lent')),
            (e: PaymentError) => e.code === 'network_timeout' && !e.retryable && e.needsReconciliation
        );
    });

    test("fetchStatus révèle que le paiement était bel et bien parti", async () => {
        const p = provider();
        await assert.rejects(() => p.execute(req('P5', 'lent')));
        // C'est TOUT l'enjeu : l'appelant croit à un échec, la vérité est autre.
        const vrai = await p.fetchStatus('P5');
        assert.equal(vrai.status, 'processing');
        assert.ok(vrai.providerReference);
    });

    test('une référence inconnue est signalée', async () => {
        await assert.rejects(
            () => provider().fetchStatus('JAMAIS-VU'),
            (e: PaymentError) => e.code === 'invalid_request'
        );
    });
});

describe('SandboxProvider — idempotence et webhooks', () => {
    test('rejouer la même référence ne recrée rien', async () => {
        const p = provider();
        const a = await p.execute(req('P6', 'ok'));
        const b = await p.execute(req('P6', 'ok'));
        assert.equal(a.providerReference, b.providerReference);
    });

    test('settle fait avancer un paiement en attente', async () => {
        const p = provider();
        const r = await p.execute(req('P7', 'attente'));
        assert.equal(r.status, 'processing');
        const evt = p.settle('P7', 'succeeded');
        assert.equal(evt.status, 'succeeded');
        assert.equal((await p.fetchStatus('P7')).status, 'succeeded');
    });

    test('un webhook « failed » retardataire est refusé après un succès', async () => {
        const p = provider();
        await p.execute(req('P8', 'attente'));
        p.settle('P8', 'succeeded');
        assert.throws(() => p.settle('P8', 'failed'), StatusTransitionError);
        assert.equal((await p.fetchStatus('P8')).status, 'succeeded');
    });

    test('parseWebhook rejette un payload malformé', () => {
        const p = provider();
        assert.equal(p.parseWebhook(null, {}), null);
        assert.equal(p.parseWebhook({ pasDeReference: 1 }, {}), null);
        assert.ok(p.parseWebhook({ reference: 'X', status: 'succeeded' }, {}));
    });
});

describe('SandboxProvider — capacités', () => {
    test('déclare la microfinance comme rail de première classe', () => {
        const rails = provider().capabilities().map((c) => c.rail);
        assert.ok(rails.includes('mfi'), 'le rail mfi doit être couvert');
        assert.ok(rails.includes('mobile_money'));
        assert.ok(rails.includes('bank'));
    });

    test('expose un solde', async () => {
        const b = await provider().balance('XOF');
        assert.equal(b.currency, 'XOF');
        assert.ok(b.isPositive());
    });
});
