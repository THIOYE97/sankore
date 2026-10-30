import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Reconciler } from '../src/core/reconciler.ts';
import { PaymentError } from '../src/core/errors.ts';
import {
    withIdempotency, MemoryIdempotencyStore, ReconciliationRequiredError,
} from '../src/core/idempotency.ts';
import { Money } from '../src/core/money.ts';
import type { PaymentProvider, PaymentResult } from '../src/core/provider.ts';
import type { Observation } from '../src/core/observability.ts';

function provider(name: string, onFetch: (ref: string) => Promise<PaymentResult>): PaymentProvider {
    return {
        name,
        capabilities: () => [],
        execute: async (req) => ({ reference: req.reference, status: 'processing' }),
        fetchStatus: onFetch,
        parseWebhook: () => null,
    };
}

/** Registre minimal — un `Router` expose la même méthode. */
const registry = (...providers: PaymentProvider[]) => ({
    provider: (name: string) => providers.find((p) => p.name === name) ?? null,
});

describe('Réconciliation — constater, jamais payer', () => {
    test('n’appelle QUE fetchStatus', async () => {
        let executes = 0;
        let fetches = 0;
        const p: PaymentProvider = {
            name: 'hub2',
            capabilities: () => [],
            execute: async (req) => { executes++; return { reference: req.reference, status: 'processing' }; },
            fetchStatus: async (reference) => { fetches++; return { reference, status: 'succeeded' }; },
            parseWebhook: () => null,
        };

        const r = new Reconciler({ providers: registry(p) });
        await r.reconcile({ reference: 'CMD-1', provider: 'hub2' });

        assert.equal(fetches, 1);
        assert.equal(executes, 0, 'un réconciliateur qui paie n’est pas un réconciliateur');
    });

    test('un état final est constaté et clôt la clé d’idempotence', async () => {
        const store = new MemoryIdempotencyStore();
        await assert.rejects(() =>
            withIdempotency('CMD-1', { store }, async () => {
                throw new PaymentError({ code: 'network_timeout' });
            })
        );
        assert.equal((await store.get('CMD-1'))?.state, 'needs_reconciliation');

        const p = provider('hub2', async (reference) => ({
            reference, status: 'succeeded', providerReference: 'tr_42', fee: Money.minor(375, 'XOF'),
        }));
        const r = new Reconciler({ providers: registry(p), store });

        const out = await r.reconcile({ reference: 'CMD-1', provider: 'hub2' });

        assert.equal(out.outcome, 'resolved');
        assert.equal(out.outcome === 'resolved' && out.status, 'succeeded');

        const rec = await store.get('CMD-1');
        assert.equal(rec?.state, 'completed');
        assert.equal(rec?.result?.providerReference, 'tr_42');
    });

    test('après clôture, un rejeu rend le résultat constaté au lieu de relancer', async () => {
        const store = new MemoryIdempotencyStore();
        await assert.rejects(() =>
            withIdempotency('CMD-2', { store }, async () => {
                throw new PaymentError({ code: 'network_timeout' });
            })
        );

        const p = provider('hub2', async (reference) => ({ reference, status: 'succeeded' }));
        await new Reconciler({ providers: registry(p), store }).reconcile({ reference: 'CMD-2', provider: 'hub2' });

        let relance = false;
        const res = await withIdempotency('CMD-2', { store }, async () => {
            relance = true;
            return { reference: 'CMD-2', status: 'failed' as const };
        });
        assert.equal(relance, false);
        assert.equal(res.status, 'succeeded');
    });

    test('un état non final laisse la clé en attente', async () => {
        const store = new MemoryIdempotencyStore();
        await assert.rejects(() =>
            withIdempotency('CMD-3', { store }, async () => {
                throw new PaymentError({ code: 'network_timeout' });
            })
        );

        const p = provider('hub2', async (reference) => ({ reference, status: 'processing' }));
        const out = await new Reconciler({ providers: registry(p), store })
            .reconcile({ reference: 'CMD-3', provider: 'hub2' });

        assert.equal(out.outcome, 'pending');
        assert.equal((await store.get('CMD-3'))?.state, 'needs_reconciliation', 'rien n’est tranché');

        await assert.rejects(
            () => withIdempotency('CMD-3', { store }, async () => ({ reference: 'CMD-3', status: 'succeeded' })),
            ReconciliationRequiredError
        );
    });
});

describe('Réconciliation — le verdict « jamais parti »', () => {
    test('not_found relâche la clé : c’est le seul rejeu légitime après un timeout', async () => {
        const store = new MemoryIdempotencyStore();
        await assert.rejects(() =>
            withIdempotency('CMD-4', { store }, async () => {
                throw new PaymentError({ code: 'network_timeout' });
            })
        );

        const p = provider('hub2', async () => {
            throw new PaymentError({ code: 'not_found', provider: 'hub2' });
        });
        const out = await new Reconciler({ providers: registry(p), store })
            .reconcile({ reference: 'CMD-4', provider: 'hub2' });

        assert.equal(out.outcome, 'never_sent');
        assert.equal(out.outcome === 'never_sent' && out.released, true);
        assert.equal(await store.get('CMD-4'), null, 'la clé est libre');

        // La référence est de nouveau utilisable — après VÉRIFICATION, pas par supposition.
        let relance = false;
        const res = await withIdempotency('CMD-4', { store }, async () => {
            relance = true;
            return { reference: 'CMD-4', status: 'succeeded' as const };
        });
        assert.equal(relance, true);
        assert.equal(res.status, 'succeeded');
    });

    test('sans store, le réconciliateur constate sans rien relâcher', async () => {
        const p = provider('hub2', async () => { throw new PaymentError({ code: 'not_found' }); });
        const out = await new Reconciler({ providers: registry(p) })
            .reconcile({ reference: 'CMD-5', provider: 'hub2' });

        assert.equal(out.outcome, 'never_sent');
        assert.equal(out.outcome === 'never_sent' && out.released, false);
    });
});

describe('Réconciliation — échecs', () => {
    test('un fournisseur injoignable laisse l’incertitude intacte', async () => {
        const store = new MemoryIdempotencyStore();
        await assert.rejects(() =>
            withIdempotency('CMD-6', { store }, async () => {
                throw new PaymentError({ code: 'network_timeout' });
            })
        );

        const p = provider('hub2', async () => {
            throw new PaymentError({ code: 'provider_unavailable', provider: 'hub2' });
        });
        const out = await new Reconciler({ providers: registry(p), store })
            .reconcile({ reference: 'CMD-6', provider: 'hub2' });

        assert.equal(out.outcome, 'unreachable');
        assert.equal((await store.get('CMD-6'))?.state, 'needs_reconciliation');
    });

    test('un fournisseur absent du registre est signalé, pas confondu avec « jamais parti »', async () => {
        const store = new MemoryIdempotencyStore();
        const out = await new Reconciler({ providers: registry(), store })
            .reconcile({ reference: 'CMD-7', provider: 'disparu' });

        assert.equal(out.outcome, 'unknown_provider');
        assert.equal(await store.get('CMD-7'), null, 'rien n’a été relâché à tort');
    });

    test('ne lève jamais : une exception inattendue devient une issue', async () => {
        const p = provider('hub2', async () => { throw new TypeError('bogue d’adaptateur'); });
        const out = await new Reconciler({ providers: registry(p) })
            .reconcile({ reference: 'CMD-8', provider: 'hub2' });

        assert.equal(out.outcome, 'unreachable');
        assert.equal(out.outcome === 'unreachable' && out.error.code, 'unknown');
    });
});

describe('Réconciliation — lots', () => {
    test('traite tout le lot et conserve l’ordre', async () => {
        const p = provider('hub2', async (reference) => ({
            reference,
            status: reference.endsWith('2') ? 'processing' : 'succeeded',
        }));
        const r = new Reconciler({ providers: registry(p), concurrency: 2 });

        const out = await r.run([
            { reference: 'CMD-1', provider: 'hub2' },
            { reference: 'CMD-2', provider: 'hub2' },
            { reference: 'CMD-3', provider: 'hub2' },
        ]);

        assert.deepEqual(out.map((o) => o.reference), ['CMD-1', 'CMD-2', 'CMD-3']);
        assert.deepEqual(out.map((o) => o.outcome), ['resolved', 'pending', 'resolved']);
    });

    test('le parallélisme est borné — les limites de débit sont basses', async () => {
        let enCours = 0;
        let pic = 0;
        const p = provider('hub2', async (reference) => {
            enCours++;
            pic = Math.max(pic, enCours);
            await new Promise((r) => setImmediate(r));
            enCours--;
            return { reference, status: 'succeeded' };
        });

        const r = new Reconciler({ providers: registry(p), concurrency: 3 });
        await r.run(Array.from({ length: 20 }, (_, i) => ({ reference: `CMD-${i}`, provider: 'hub2' })));

        assert.ok(pic <= 3, `pic de parallélisme observé : ${pic}`);
    });

    test('un lot vide ne fait rien', async () => {
        const r = new Reconciler({ providers: registry() });
        assert.deepEqual(await r.run([]), []);
    });

    test('le décompte alimente une métrique en une ligne', async () => {
        const p = provider('hub2', async (reference) => ({
            reference, status: reference === 'CMD-2' ? 'processing' : 'succeeded',
        }));
        const out = await new Reconciler({ providers: registry(p) }).run([
            { reference: 'CMD-1', provider: 'hub2' },
            { reference: 'CMD-2', provider: 'hub2' },
            { reference: 'CMD-3', provider: 'absent' },
        ]);

        assert.deepEqual(Reconciler.summarize(out), {
            resolved: 1, pending: 1, never_sent: 0, unknown_provider: 1, unreachable: 0,
        });
    });
});

describe('Réconciliation — observabilité', () => {
    test('chaque étape est observable', async () => {
        const vus: Observation[] = [];
        const p = provider('hub2', async (reference) => ({ reference, status: 'succeeded' }));
        const r = new Reconciler({ providers: registry(p), observer: (o) => vus.push(o) });

        await r.reconcile({ reference: 'CMD-1', provider: 'hub2' });

        assert.deepEqual(vus.map((o) => o.kind), ['reconcile.started', 'reconcile.resolved']);
        assert.equal(vus[1]?.paymentStatus, 'succeeded');
    });
});
