import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/core/router.ts';
import { Money } from '../src/core/money.ts';
import { PaymentError } from '../src/core/errors.ts';
import {
    MemoryIdempotencyStore, DuplicateInFlightError, ReconciliationRequiredError,
} from '../src/core/idempotency.ts';
import type { PaymentProvider, PaymentRequest, PaymentResult, Capability } from '../src/core/provider.ts';
import type { Observation } from '../src/core/observability.ts';

const MOBILE_ML: Capability = {
    rail: 'mobile_money', country: 'ML', currency: 'XOF', direction: 'payout',
    minAmount: 500, maxAmount: 2_000_000,
};

function fakeProvider(
    name: string,
    behaviour: (req: PaymentRequest) => Promise<PaymentResult>,
    caps: readonly Capability[] = [MOBILE_ML]
): PaymentProvider {
    return {
        name,
        capabilities: () => caps,
        execute: behaviour,
        fetchStatus: async (reference) => ({ reference, status: 'succeeded' }),
        parseWebhook: () => null,
    };
}

const req = (reference = 'CMD-1'): PaymentRequest => ({
    reference,
    direction: 'payout',
    amount: Money.major(10_000, 'XOF'),
    account: { rail: 'mobile_money', country: 'ML', identifier: '22370000000', institution: 'orange' },
});

describe('Routeur — l’idempotence n’est plus à la charge de l’appelant', () => {
    test('deux execute() sur la même référence n’exécutent qu’une fois', async () => {
        let appels = 0;
        const store = new MemoryIdempotencyStore();
        const r = new Router(
            [fakeProvider('a', async (rq) => { appels++; return { reference: rq.reference, status: 'succeeded' }; })],
            { idempotency: { store } }
        );

        const premier = await r.execute(req());
        const second = await r.execute(req());

        assert.equal(appels, 1, 'c’est tout l’objet de la bibliothèque');
        assert.deepEqual(premier, second);
    });

    test('sans store, le comportement d’avant est conservé', async () => {
        let appels = 0;
        const r = new Router([fakeProvider('a', async (rq) => {
            appels++;
            return { reference: rq.reference, status: 'succeeded' };
        })]);

        await r.execute(req());
        await r.execute(req());
        assert.equal(appels, 2);
    });

    test('un appel concurrent est refusé, pas dupliqué', async () => {
        const store = new MemoryIdempotencyStore();
        let resoudre: (v: PaymentResult) => void = () => {};
        const r = new Router(
            [fakeProvider('a', () => new Promise<PaymentResult>((res) => { resoudre = res; }))],
            { idempotency: { store } }
        );

        const enCours = r.execute(req());
        await assert.rejects(() => r.execute(req()), DuplicateInFlightError);

        resoudre({ reference: 'CMD-1', status: 'succeeded' });
        await enCours;
    });

    test('un timeout bloque le rejeu au profit d’une réconciliation', async () => {
        const store = new MemoryIdempotencyStore();
        let appels = 0;
        const r = new Router(
            [fakeProvider('a', async () => {
                appels++;
                throw new PaymentError({ code: 'network_timeout', provider: 'a' });
            })],
            { idempotency: { store } }
        );

        await assert.rejects(() => r.execute(req()), (e: PaymentError) => e.code === 'network_timeout');
        await assert.rejects(() => r.execute(req()), ReconciliationRequiredError);
        assert.equal(appels, 1, 'le second appel ne doit JAMAIS atteindre le fournisseur');
    });

    test('la clé peut être préfixée — indispensable en multi-locataires', async () => {
        const store = new MemoryIdempotencyStore();
        let appels = 0;
        const r = new Router(
            [fakeProvider('a', async (rq) => { appels++; return { reference: rq.reference, status: 'succeeded' }; })],
            {
                idempotency: {
                    store,
                    keyFor: (rq) => `${rq.metadata?.['tenant'] ?? 'nul'}:${rq.reference}`,
                },
            }
        );

        await r.execute({ ...req('CMD-1'), metadata: { tenant: 'client-a' } });
        await r.execute({ ...req('CMD-1'), metadata: { tenant: 'client-b' } });

        assert.equal(appels, 2, 'deux locataires peuvent employer la même référence');
    });
});

describe('Routeur — disjoncteur', () => {
    test('un fournisseur en panne est relégué derrière les autres', async () => {
        const mort = fakeProvider('mort', async () => {
            throw new PaymentError({ code: 'provider_unavailable', provider: 'mort' });
        });
        const vivant = fakeProvider('vivant', async (rq) => ({ reference: rq.reference, status: 'succeeded' }));

        const r = new Router([mort, vivant], {
            preference: ['mort', 'vivant'],
            failover: true,
            breaker: { failureThreshold: 2 },
        });

        // Deux échecs ouvrent le disjoncteur de « mort ».
        await r.execute(req('CMD-1'));
        await r.execute(req('CMD-2'));

        const ordre = r.candidates({
            rail: 'mobile_money', country: 'ML', currency: 'XOF', direction: 'payout', amount: 10_000,
        }).map((p) => p.name);

        assert.deepEqual(ordre, ['vivant', 'mort'], 'la préférence cède devant la santé réelle');
    });

    test('le refus du disjoncteur n’atteint pas le réseau', async () => {
        let appels = 0;
        const mort = fakeProvider('mort', async () => {
            appels++;
            throw new PaymentError({ code: 'provider_unavailable', provider: 'mort' });
        });

        const r = new Router([mort], { breaker: { failureThreshold: 1 } });

        await assert.rejects(() => r.execute(req('CMD-1')));
        assert.equal(appels, 1);

        await assert.rejects(
            () => r.execute(req('CMD-2')),
            (e: PaymentError) => e.message.includes('disjoncteur')
        );
        assert.equal(appels, 1, 'le second appel est refusé sans appel réseau');
    });

    test('si TOUS sont en panne, on tente quand même — « corridor non couvert » serait un mensonge', async () => {
        let appels = 0;
        const mort = fakeProvider('mort', async () => {
            appels++;
            throw new PaymentError({ code: 'provider_unavailable' });
        });
        const r = new Router([mort], { breaker: { failureThreshold: 1 } });

        await assert.rejects(() => r.execute(req('CMD-1')));
        const liste = r.candidates({
            rail: 'mobile_money', country: 'ML', currency: 'XOF', direction: 'payout', amount: 10_000,
        });
        assert.equal(liste.length, 1, 'le fournisseur reste éligible, seulement relégué');
        assert.equal(appels, 1);
    });

    test('health() expose l’état, et reste vide si les disjoncteurs sont désactivés', async () => {
        const mort = fakeProvider('mort', async () => { throw new PaymentError({ code: 'network_timeout' }); });

        const sans = new Router([mort]);
        assert.deepEqual(sans.health(), [], 'ne rien raconter vaut mieux que raconter faux');

        const avec = new Router([mort], { breaker: { failureThreshold: 1 } });
        await assert.rejects(() => avec.execute(req()));
        assert.deepEqual(avec.health().map((h) => [h.provider, h.state]), [['mort', 'open']]);
    });
});

describe('Routeur — observabilité', () => {
    test('un succès est observé avec son fournisseur et sa durée', async () => {
        const vus: Observation[] = [];
        const r = new Router(
            [fakeProvider('a', async (rq) => ({
                reference: rq.reference, status: 'succeeded', providerReference: 'tr_1',
            }))],
            { observer: (o) => vus.push(o) }
        );

        await r.execute(req());

        assert.deepEqual(vus.map((o) => o.kind), ['payment.routed', 'payment.succeeded']);
        const fin = vus[1];
        assert.equal(fin?.provider, 'a');
        assert.equal(fin?.reference, 'CMD-1');
        assert.equal(fin?.paymentStatus, 'succeeded');
        assert.equal(typeof fin?.durationMs, 'number');
        assert.equal(fin?.detail?.['final'], true);
    });

    test('un refus RENDU et une panne LEVÉE ne se confondent pas', async () => {
        const vus: Observation[] = [];
        const refus = new Router(
            [fakeProvider('a', async (rq) => ({
                reference: rq.reference,
                status: 'failed',
                error: new PaymentError({ code: 'insufficient_funds', provider: 'a', providerCode: '1004' }),
            }))],
            { observer: (o) => vus.push(o) }
        );
        await refus.execute(req());

        const echec = vus.find((o) => o.kind === 'payment.failed');
        assert.equal(echec?.detail?.['thrown'], false, 'un solde insuffisant n’est pas une panne');
        assert.equal(echec?.code, 'insufficient_funds');
        assert.equal(echec?.providerCode, '1004');

        const vus2: Observation[] = [];
        const panne = new Router(
            [fakeProvider('b', async () => { throw new PaymentError({ code: 'provider_unavailable' }); })],
            { observer: (o) => vus2.push(o) }
        );
        await assert.rejects(() => panne.execute(req()));

        const leve = vus2.find((o) => o.kind === 'payment.failed');
        assert.equal(leve?.detail?.['thrown'], true);
        assert.equal(leve?.detail?.['retryable'], true);
    });

    test('un encaissement en attente d’action est observé comme tel', async () => {
        const vus: Observation[] = [];
        const r = new Router(
            [fakeProvider('a', async (rq) => ({
                reference: rq.reference,
                status: 'action_required',
                action: { type: 'ussd', message: 'Composez #144#' },
            }))],
            { observer: (o) => vus.push(o) }
        );
        await r.execute(req());

        const fin = vus.find((o) => o.kind === 'payment.pending');
        assert.equal(fin?.paymentStatus, 'action_required');
        assert.equal(fin?.detail?.['action'], 'ussd');
        assert.equal(fin?.detail?.['final'], false);
    });

    test('la bascule et le corridor non couvert sont observables', async () => {
        const vus: Observation[] = [];
        const r = new Router(
            [
                fakeProvider('a', async () => { throw new PaymentError({ code: 'provider_unavailable' }); }),
                fakeProvider('b', async (rq) => ({ reference: rq.reference, status: 'succeeded' })),
            ],
            { preference: ['a', 'b'], failover: true, observer: (o) => vus.push(o) }
        );
        await r.execute(req());

        const bascule = vus.find((o) => o.kind === 'payment.failover');
        assert.equal(bascule?.provider, 'b');
        assert.equal(bascule?.detail?.['from'], 'a');

        const vide: Observation[] = [];
        const nul = new Router([], { observer: (o) => vide.push(o) });
        await assert.rejects(() => nul.execute(req()));
        assert.equal(vide[0]?.kind, 'payment.unroutable');
    });

    test('un rejeu intercepté par l’idempotence est observable', async () => {
        const vus: Observation[] = [];
        const store = new MemoryIdempotencyStore();
        const r = new Router(
            [fakeProvider('a', async (rq) => ({ reference: rq.reference, status: 'succeeded' }))],
            { idempotency: { store }, observer: (o) => vus.push(o) }
        );

        await r.execute(req());
        await r.execute(req());

        const doublon = vus.find((o) => o.kind === 'payment.duplicate');
        assert.equal(doublon?.reference, 'CMD-1');
        assert.equal(doublon?.detail?.['state'], 'completed');
    });
});

describe('Routeur — registre', () => {
    test('un fournisseur est retrouvable par son nom — indispensable pour réconcilier', () => {
        const r = new Router([fakeProvider('hub2', async (rq) => ({ reference: rq.reference, status: 'succeeded' }))]);
        assert.equal(r.provider('hub2')?.name, 'hub2');
        assert.equal(r.provider('inconnu'), null);
        assert.equal(r.all().length, 1);
    });
});
