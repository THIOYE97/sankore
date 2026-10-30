import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub2Provider } from '../src/providers/hub2.ts';
import { Money } from '../src/core/money.ts';
import { PaymentError } from '../src/core/errors.ts';
import { Router } from '../src/core/router.ts';
import type { PaymentRequest } from '../src/core/provider.ts';

/* ------------------------------------------------------------------ *
 * Outillage — aucun réseau, tout est injecté
 * ------------------------------------------------------------------ */

interface Recorded {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown> | undefined;
}

type Queued = { status: number; body?: unknown } | 'abort';

function stubFetch(queue: Queued[]) {
    const calls: Recorded[] = [];
    let i = 0;
    const impl = (async (url: string, init: RequestInit) => {
        calls.push({
            url: String(url),
            method: init.method ?? 'GET',
            headers: (init.headers ?? {}) as Record<string, string>,
            body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        const r = queue[Math.min(i++, queue.length - 1)];
        if (r === 'abort') {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
        }
        return new Response(JSON.stringify(r?.body ?? {}), {
            status: r?.status ?? 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof fetch;
    return { impl, calls };
}

function hub2(queue: Queued[], opts: Record<string, unknown> = {}) {
    const { impl, calls } = stubFetch(queue);
    const provider = new Hub2Provider({
        apiKey: 'cle-test',
        merchantId: 'marchand-test',
        fetchImpl: impl,
        retryBaseMs: 1,
        ...opts,
    } as never);
    return { provider, calls };
}

/** Virement Hub2 tel que renvoyé par l'API, réduit aux champs utilisés. */
function transfer(over: Record<string, unknown> = {}) {
    return {
        id: 'tr_z1urYtVFgEebtcj8fxp4v',
        merchantId: 'marchand-test',
        reference: 'PAY-2026-00042',
        description: 'Salaire août',
        status: 'successful',
        amount: 25_000,
        currency: 'XOF',
        mode: 'sandbox',
        createdAt: '2026-08-05T10:00:00.000Z',
        providerReference: 'OM-99887766',
        fees: [],
        destination: { type: 'mobile_money', country: 'ML', msisdn: '+22370000000', provider: 'orange' },
        ...over,
    };
}

const REQUEST: PaymentRequest = {
    reference: 'PAY-2026-00042',
    direction: 'payout',
    amount: Money.major(25_000, 'XOF'),
    account: { rail: 'mobile_money', country: 'ML', identifier: '22370000000', institution: 'Orange' },
    label: 'Salaire août',
};

/* ------------------------------------------------------------------ *
 * Requête sortante
 * ------------------------------------------------------------------ */

describe('Hub2 — la requête envoyée', () => {
    test('les trois en-têtes d’authentification partent, en sandbox par défaut', async () => {
        const { provider, calls } = hub2([{ status: 201, body: transfer() }]);
        await provider.execute(REQUEST);

        assert.equal(calls[0]?.headers['ApiKey'], 'cle-test');
        assert.equal(calls[0]?.headers['MerchantId'], 'marchand-test');
        assert.equal(calls[0]?.headers['Environment'], 'sandbox',
            'le mode live doit toujours être un choix explicite');
        assert.equal(provider.environment, 'sandbox');
    });

    test('`live` doit être demandé explicitement', async () => {
        const { provider, calls } = hub2([{ status: 201, body: transfer({ mode: 'live' }) }], {
            environment: 'live',
        });
        await provider.execute(REQUEST);
        assert.equal(calls[0]?.headers['Environment'], 'live');
    });

    test('25 000 XOF partent comme 25000 — jamais multipliés par 100', async () => {
        const { provider, calls } = hub2([{ status: 201, body: transfer() }]);
        await provider.execute(REQUEST);

        assert.equal(calls[0]?.body?.['amount'], 25_000, 'le XOF n’a pas de décimale');
        assert.equal(calls[0]?.body?.['currency'], 'XOF');
        assert.equal(calls[0]?.url, 'https://api.hub2.io/transfers');
        assert.equal(calls[0]?.method, 'POST');
    });

    test('la destination mobile money suit le schéma Hub2', async () => {
        const { provider, calls } = hub2([{ status: 201, body: transfer() }]);
        await provider.execute({
            ...REQUEST,
            account: { ...REQUEST.account, holderName: 'Aminata Traoré' },
        });

        assert.deepEqual(calls[0]?.body?.['destination'], {
            type: 'mobile_money',
            country: 'ML',
            msisdn: '+22370000000',
            provider: 'orange',
            recipientName: 'Aminata Traoré',
        });
    });

    test('l’opérateur est mis en minuscules et le numéro préfixé de « + »', async () => {
        const { provider, calls } = hub2([{ status: 201, body: transfer() }]);
        await provider.execute({
            ...REQUEST,
            account: { ...REQUEST.account, identifier: '+223 70 00 00 00', institution: 'ORANGE' },
        });

        const destination = calls[0]?.body?.['destination'] as Record<string, unknown>;
        assert.equal(destination['provider'], 'orange');
        assert.equal(destination['msisdn'], '+22370000000');
    });

    test('sans libellé, la référence sert de description (champ obligatoire chez Hub2)', async () => {
        const { provider, calls } = hub2([{ status: 201, body: transfer() }]);
        const { label: _label, ...sansLibelle } = REQUEST;
        await provider.execute(sansLibelle);
        assert.equal(calls[0]?.body?.['description'], 'PAY-2026-00042');
    });

    test('businessName et origin sont transmis quand ils sont configurés', async () => {
        const { provider, calls } = hub2([{ status: 201, body: transfer() }], {
            businessName: 'RelayOps',
            origin: { name: 'RelayOps', country: 'ML' },
        });
        await provider.execute(REQUEST);

        assert.equal(calls[0]?.body?.['overrideBusinessName'], 'RelayOps');
        assert.deepEqual(calls[0]?.body?.['origin'], { name: 'RelayOps', country: 'ML' });
    });
});

/* ------------------------------------------------------------------ *
 * Refus en amont
 * ------------------------------------------------------------------ */

describe('Hub2 — ce qui est refusé sans appeler le réseau', () => {
    test('une référence à caractères interdits est rejetée ici, pas par un 400 opaque', async () => {
        const { provider, calls } = hub2([{ status: 201, body: transfer() }]);
        await assert.rejects(
            () => provider.execute({ ...REQUEST, reference: 'PAY/2026#42' }),
            (e: PaymentError) => e.code === 'invalid_request'
        );
        assert.equal(calls.length, 0, 'aucun appel réseau inutile');
    });

    test('le mobile money sans opérateur est refusé', async () => {
        const { provider, calls } = hub2([{ status: 201, body: transfer() }]);
        await assert.rejects(
            () => provider.execute({
                ...REQUEST,
                account: { rail: 'mobile_money', country: 'ML', identifier: '22370000000' },
            }),
            (e: PaymentError) => e.code === 'invalid_request'
        );
        assert.equal(calls.length, 0);
    });

    test('un encaissement n’emprunte JAMAIS l’API de virement', async () => {
        const { provider, calls } = hub2([{ status: 200, body: [] }, { status: 201, body: {} }]);
        // Peu importe l'issue : ce qui compte est qu'aucun `POST /transfers`
        // ne parte. Confondre les deux sens enverrait de l'argent au lieu
        // d'en demander.
        await provider.execute({ ...REQUEST, direction: 'payin' }).catch(() => {});
        assert.equal(
            calls.some((c) => c.url.includes('/transfers')), false,
            'un encaissement passe par les intentions de paiement, pas par les virements'
        );
    });

    test('un rail non couvert est refusé sans appel', async () => {
        const { provider, calls } = hub2([{ status: 201, body: transfer() }]);
        await assert.rejects(
            () => provider.execute({
                ...REQUEST,
                account: { rail: 'mfi', country: 'ML', identifier: 'CPT-1', institution: 'kafo' },
            }),
            (e: PaymentError) => e.code === 'unsupported_corridor'
        );
        assert.equal(calls.length, 0);
    });

    test('un montant nul est refusé', async () => {
        const { provider } = hub2([{ status: 201, body: transfer() }]);
        await assert.rejects(
            () => provider.execute({ ...REQUEST, amount: Money.zero('XOF') }),
            (e: PaymentError) => e.code === 'invalid_request'
        );
    });
});

/* ------------------------------------------------------------------ *
 * Lecture de la réponse
 * ------------------------------------------------------------------ */

describe('Hub2 — traduction de la réponse', () => {
    test('les quatre statuts Hub2 deviennent le vocabulaire de Sankoré', async () => {
        const attendus: Array<[string, string]> = [
            ['created', 'pending'],
            ['pending', 'processing'],   // faux ami : « pending » chez Hub2 = en cours
            ['successful', 'succeeded'],
            ['failed', 'failed'],
        ];
        for (const [hub2Status, sankore] of attendus) {
            const { provider } = hub2([{ status: 201, body: transfer({ status: hub2Status }) }]);
            const result = await provider.execute(REQUEST);
            assert.equal(result.status, sankore, `${hub2Status} -> ${sankore}`);
        }
    });

    test('l’identifiant retenu est celui qui permet de réinterroger Hub2', async () => {
        const { provider } = hub2([{ status: 201, body: transfer() }]);
        const result = await provider.execute(REQUEST);
        assert.equal(result.providerReference, 'tr_z1urYtVFgEebtcj8fxp4v');
        assert.equal(result.reference, 'PAY-2026-00042');
    });

    test('les frais sont additionnés dans la devise du virement', async () => {
        const { provider } = hub2([{
            status: 201,
            body: transfer({
                fees: [
                    { id: 'f1', rate: 1, type: 'percent', amount: 250, currency: 'XOF', taxes: [] },
                    { id: 'f2', rate: 50, type: 'flat', amount: 50, currency: 'XOF', taxes: [] },
                    { id: 'f3', rate: 1, type: 'flat', amount: 999, currency: 'XAF', taxes: [] },
                ],
            }),
        }]);
        const result = await provider.execute(REQUEST);
        assert.ok(result.fee);
        assert.equal(result.fee.amount, 300, 'les frais en XAF ne se mélangent pas aux XOF');
        assert.equal(result.fee.currency, 'XOF');
    });

    test('sans frais communiqués, le champ reste absent plutôt que faussement nul', async () => {
        const { provider } = hub2([{ status: 201, body: transfer({ fees: [] }) }]);
        const result = await provider.execute(REQUEST);
        assert.equal(result.fee, undefined);
    });

    test('un statut inconnu est signalé plutôt qu’interprété', async () => {
        const { provider } = hub2([{ status: 201, body: transfer({ status: 'en_attente_du_facteur' }) }]);
        await assert.rejects(
            () => provider.execute(REQUEST),
            (e: PaymentError) => e.code === 'provider_error'
        );
    });
});

/* ------------------------------------------------------------------ *
 * Causes d'échec
 * ------------------------------------------------------------------ */

describe('Hub2 — les 17 causes d’échec', () => {
    const table: Array<[string, string]> = [
        ['insufficient_funds', 'insufficient_funds'],
        ['invalid_destination', 'invalid_account'],
        ['destination_not_allowed', 'account_blocked'],
        ['blacklisted_msisdn', 'account_blocked'],
        ['fraud_suspicion', 'account_blocked'],
        ['forbidden_by_provider', 'account_blocked'],
        ['canceled', 'customer_declined'],
        ['unsupported_currency', 'unsupported_corridor'],
        ['invalid_amount', 'invalid_request'],
        ['bad_request', 'invalid_request'],
        ['invalid_payment_processor', 'invalid_request'],
        ['duplicate_request', 'duplicate_request'],
        ['service_unavailable', 'provider_unavailable'],
        ['too_many_request', 'rate_limited'],
        ['timeout', 'network_timeout'],
        ['internal_error', 'provider_error'],
        ['unknown_reason', 'unknown'],
    ];

    for (const [hub2Code, sankoreCode] of table) {
        test(`${hub2Code} -> ${sankoreCode}`, async () => {
            const { provider } = hub2([{
                status: 201,
                body: transfer({
                    status: 'failed',
                    failureCause: { code: hub2Code, message: 'message Hub2', params: [] },
                }),
            }]);
            const result = await provider.execute(REQUEST);
            assert.equal(result.status, 'failed');
            assert.equal(result.error?.code, sankoreCode);
            assert.equal(result.error?.providerCode, hub2Code, 'le code brut reste disponible pour le support');
        });
    }

    test('une cause inconnue de Hub2 ne casse rien — elle devient `unknown`', async () => {
        const { provider } = hub2([{
            status: 201,
            body: transfer({ status: 'failed', failureCause: { code: 'cause_inventee_demain', message: '', params: [] } }),
        }]);
        const result = await provider.execute(REQUEST);
        assert.equal(result.error?.code, 'unknown');
        assert.equal(result.error?.providerCode, 'cause_inventee_demain');
    });

    test('un échec pour solde insuffisant porte un message client en français', async () => {
        const { provider } = hub2([{
            status: 201,
            body: transfer({ status: 'failed', failureCause: { code: 'insufficient_funds', message: '', params: [] } }),
        }]);
        const result = await provider.execute(REQUEST);
        assert.equal(result.error?.customerMessage(), 'Solde insuffisant sur le compte.');
    });
});

/* ------------------------------------------------------------------ *
 * Sécurité des reprises
 * ------------------------------------------------------------------ */

describe('Hub2 — la règle qui protège l’argent', () => {
    test('une création n’est JAMAIS rejouée, même sur 503', async () => {
        const { provider, calls } = hub2([{ status: 503 }, { status: 201, body: transfer() }]);
        await assert.rejects(
            () => provider.execute(REQUEST),
            (e: PaymentError) => e.code === 'provider_unavailable'
        );
        assert.equal(calls.length, 1,
            'un 502/503 sur un POST ne prouve pas que rien n’est parti');
    });

    test('un timeout sur la création remonte non rejouable et à réconcilier', async () => {
        const { provider, calls } = hub2(['abort']);
        await assert.rejects(
            () => provider.execute(REQUEST),
            (e: PaymentError) => e.code === 'network_timeout' && !e.retryable && e.needsReconciliation
        );
        assert.equal(calls.length, 1);
    });

    test('une LECTURE, elle, est bien rejouée sur 503', async () => {
        const { provider, calls } = hub2([{ status: 503 }, { status: 200, body: [transfer()] }]);
        const result = await provider.fetchStatus('PAY-2026-00042');
        assert.equal(result.status, 'succeeded');
        assert.equal(calls.length, 2, 'relire est sans danger');
    });
});

/* ------------------------------------------------------------------ *
 * Idempotence
 * ------------------------------------------------------------------ */

describe('Hub2 — idempotence sur la référence', () => {
    test('un 409 dont la référence existe déjà rend l’état réel, sans rien recréer', async () => {
        const { provider, calls } = hub2([
            { status: 409, body: { httpStatus: 409, type: 'invalid_request', code: 'unsupported_action', message: 'déjà vu' } },
            { status: 200, body: [transfer({ status: 'pending' })] },
        ]);

        const result = await provider.execute(REQUEST);
        assert.equal(result.status, 'processing');
        assert.equal(result.providerReference, 'tr_z1urYtVFgEebtcj8fxp4v');
        assert.equal(calls.length, 2);
        assert.equal(calls[1]?.method, 'GET');
        assert.match(calls[1]?.url ?? '', /\/transfers\?reference=PAY-2026-00042$/);
    });

    test('un 409 sans virement correspondant remonte l’erreur telle quelle', async () => {
        const { provider } = hub2([{ status: 409 }, { status: 200, body: [] }]);
        await assert.rejects(
            () => provider.execute(REQUEST),
            (e: PaymentError) => e.code === 'duplicate_request'
        );
    });
});

/* ------------------------------------------------------------------ *
 * Réconciliation
 * ------------------------------------------------------------------ */

describe('Hub2 — réconciliation par référence', () => {
    test('après un timeout, la référence applicative suffit à retrouver l’opération', async () => {
        // Le scénario réel : le POST a expiré, on n'a jamais reçu l'identifiant
        // `tr_…`. C'est précisément là qu'un index par identifiant ne servirait à rien.
        const { provider, calls } = hub2(['abort']);
        await assert.rejects(() => provider.execute(REQUEST));

        const { provider: relecture } = hub2([{ status: 200, body: [transfer({ status: 'successful' })] }]);
        const verite = await relecture.fetchStatus('PAY-2026-00042');

        assert.equal(verite.status, 'succeeded', 'le virement était bien parti');
        assert.equal(calls.length, 1);
    });

    test('une référence inconnue de Hub2 est signalée clairement', async () => {
        const { provider } = hub2([{ status: 200, body: [] }]);
        await assert.rejects(
            () => provider.fetchStatus('PAY-INEXISTANT'),
            // `not_found` est un verdict : rien n'est parti. C'est ce code que le
            // `Reconciler` exige pour relâcher un verrou d'idempotence.
            (e: PaymentError) => e.code === 'not_found'
        );
    });

    test('en cas de doublon de référence, c’est le plus récent qui fait foi', async () => {
        const { provider } = hub2([{
            status: 200,
            body: [
                transfer({ id: 'tr_ancien', createdAt: '2026-08-01T00:00:00.000Z', status: 'failed' }),
                transfer({ id: 'tr_recent', createdAt: '2026-08-05T00:00:00.000Z', status: 'successful' }),
            ],
        }]);
        const result = await provider.fetchStatus('PAY-2026-00042');
        assert.equal(result.providerReference, 'tr_recent');
        assert.equal(result.status, 'succeeded');
    });
});

/* ------------------------------------------------------------------ *
 * Webhooks
 * ------------------------------------------------------------------ */

describe('Hub2 — webhooks', () => {
    const event = {
        owner: 'marchand-test',
        type: 'transfer.succeeded',
        id: 'evt_1',
        test: true,
        createdAt: '2026-08-05T10:01:00.000Z',
        data: transfer(),
    };

    test('un événement transfer.* est normalisé', () => {
        const { provider } = hub2([]);
        const parsed = provider.parseWebhook(event, {});
        assert.equal(parsed?.reference, 'PAY-2026-00042');
        assert.equal(parsed?.status, 'succeeded');
        assert.equal(parsed?.providerReference, 'tr_z1urYtVFgEebtcj8fxp4v');
    });

    test('le corps brut est accepté et analysé', () => {
        const { provider } = hub2([]);
        const parsed = provider.parseWebhook(JSON.stringify(event), {});
        assert.equal(parsed?.status, 'succeeded');
    });

    test('le statut porté par l’objet prime sur le type d’événement', () => {
        const { provider } = hub2([]);
        // Type « succeeded » mais objet encore en cours : l'objet fait foi.
        const parsed = provider.parseWebhook(
            { ...event, data: transfer({ status: 'pending' }) }, {}
        );
        assert.equal(parsed?.status, 'processing');
    });

    test('un événement sans statut retombe sur le type', () => {
        const { provider } = hub2([]);
        const sansStatut = { ...transfer() } as Record<string, unknown>;
        delete sansStatut['status'];
        const parsed = provider.parseWebhook({ ...event, type: 'transfer.processing', data: sansStatut }, {});
        assert.equal(parsed?.status, 'processing');
    });

    test('un échec transporte l’erreur normalisée', () => {
        const { provider } = hub2([]);
        const parsed = provider.parseWebhook({
            ...event,
            type: 'transfer.failed',
            data: transfer({ status: 'failed', failureCause: { code: 'blacklisted_msisdn', message: '', params: [] } }),
        }, {});
        assert.equal(parsed?.status, 'failed');
        assert.equal(parsed?.error?.code, 'account_blocked');
    });

    test('les événements `payment.*` sont ignorés — ils ne portent pas la référence', () => {
        const { provider } = hub2([]);
        // Un objet `Payment` ne contient que `intentId`. Impossible de le
        // rattacher à une référence applicative sans une lecture de plus.
        assert.equal(provider.parseWebhook({ ...event, type: 'payment.succeeded' }, {}), null);
    });

    test('un JSON invalide est refusé', () => {
        const { provider } = hub2([]);
        assert.equal(provider.parseWebhook('{ceci n’est pas du JSON', {}), null);
    });

    test('avec un vérificateur, une signature refusée annule tout', () => {
        const { provider } = hub2([], { verifyWebhook: () => false });
        assert.equal(provider.parseWebhook(JSON.stringify(event), { 'x-signature': 'faux' }), null);
    });

    test('avec un vérificateur, une signature acceptée laisse passer', () => {
        const { provider } = hub2([], {
            verifyWebhook: (raw: string, headers: Record<string, string>) =>
                headers['x-signature'] === `signe:${raw.length}`,
        });
        const raw = JSON.stringify(event);
        const parsed = provider.parseWebhook(raw, { 'x-signature': `signe:${raw.length}` });
        assert.equal(parsed?.status, 'succeeded');
    });

    test('un vérificateur configuré REFUSE un objet déjà analysé', () => {
        // Une signature se calcule sur des octets. Re-sérialiser ne restitue pas
        // l'ordre des clés : on ne peut pas vérifier, donc on ne valide pas.
        const { provider } = hub2([], { verifyWebhook: () => true });
        assert.equal(provider.parseWebhook(event, {}), null);
    });
});

/* ------------------------------------------------------------------ *
 * Solde
 * ------------------------------------------------------------------ */

describe('Hub2 — solde', () => {
    test('le solde disponible du compte de virement est additionné par devise', async () => {
        const { provider, calls } = hub2([{
            status: 200,
            body: {
                collectionAccount: [{ availableBalance: 999, currency: 'XOF', amount: 999, date: '' }],
                transferAccount: [
                    { availableBalance: 1_200_000, currency: 'XOF', amount: 1_200_000, date: '' },
                    { availableBalance: 300_000, currency: 'XOF', amount: 300_000, date: '' },
                    { availableBalance: 77, currency: 'XAF', amount: 77, date: '' },
                ],
                transferIrtAccount: [],
            },
        }]);

        const solde = await provider.balance('XOF');
        assert.equal(solde.amount, 1_500_000, 'le compte d’encaissement ne compte pas');
        assert.equal(solde.currency, 'XOF');
        assert.match(calls[0]?.url ?? '', /\/balance\?currency=XOF$/);
    });

    test('une devise sans compte de virement est signalée', async () => {
        const { provider } = hub2([{
            status: 200,
            body: { collectionAccount: [], transferAccount: [], transferIrtAccount: [] },
        }]);
        await assert.rejects(
            () => provider.balance('GHS'),
            (e: PaymentError) => e.code === 'invalid_request'
        );
    });
});

/* ------------------------------------------------------------------ *
 * Corridors et routage
 * ------------------------------------------------------------------ */

describe('Hub2 — corridors', () => {
    test('la table intégrée couvre les corridors relevés chez Hub2', () => {
        const { provider } = hub2([]);
        const caps = provider.capabilities();

        const mali = caps.find((c) => c.country === 'ML');
        assert.ok(mali, 'le Mali est couvert');
        assert.equal(mali.currency, 'XOF');
        assert.deepEqual([...mali.institutions ?? []], ['orange', 'mobicash']);

        const guinee = caps.find((c) => c.country === 'GN');
        assert.equal(guinee?.currency, 'GNF', 'la Guinée est en francs guinéens, pas en CFA');

        // Hub2 ne distingue pas le sens dans sa liste d'opérateurs : les mêmes
        // corridors servent à envoyer et à encaisser.
        assert.ok(caps.some((c) => c.country === 'ML' && c.direction === 'payout'));
        assert.ok(caps.some((c) => c.country === 'ML' && c.direction === 'payin'));
        assert.ok(caps.every((c) => c.rail === 'mobile_money'));
    });

    test('le routeur choisit Hub2 sur un corridor couvert', async () => {
        const { provider } = hub2([{ status: 201, body: transfer() }]);
        const router = new Router([provider]);

        const choisi = router.resolve({
            rail: 'mobile_money', country: 'ML', currency: 'XOF',
            direction: 'payout', amount: 25_000, institution: 'orange',
        });
        assert.equal(choisi?.name, 'hub2');
    });

    test('le routeur écarte Hub2 sur un opérateur qu’il ne sert pas', () => {
        const { provider } = hub2([]);
        const router = new Router([provider]);

        const choisi = router.resolve({
            rail: 'mobile_money', country: 'ML', currency: 'XOF',
            direction: 'payout', amount: 25_000, institution: 'wave',  // Wave n'est pas au Mali chez Hub2
        });
        assert.equal(choisi, null);
    });

    test('fetchCapabilities lit la couverture du jour et normalise les opérateurs', async () => {
        const { impl, calls } = stubFetch([{
            status: 200,
            body: [
                { id: 'pr_1', country: 'ML', name: 'Orange', method: 'mobile_money', currency: 'XOF' },
                { id: 'pr_2', country: 'ML', name: 'Mobicash', method: 'mobile_money', currency: 'XOF' },
                { id: 'pr_3', country: 'CI', name: 'Wave', method: 'mobile_money', currency: 'XOF' },
                { id: 'pr_4', country: 'CI', name: 'Ecobank', method: 'credit_card', currency: 'XOF' },
            ],
        }]);

        const caps = await Hub2Provider.fetchCapabilities({ fetchImpl: impl, directions: ['payout'] });
        assert.equal(calls[0]?.url, 'https://api.hub2.io/data/providers');
        assert.equal(caps.length, 2, 'un corridor par couple pays/devise');

        const mali = caps.find((c) => c.country === 'ML');
        assert.deepEqual([...mali?.institutions ?? []], ['orange', 'mobicash'],
            'Hub2 renvoie « Orange », son API de virement exige « orange »');

        assert.ok(caps.every((c) => c.rail === 'mobile_money'),
            'la carte bancaire n’est pas un rail de décaissement');
    });
});
