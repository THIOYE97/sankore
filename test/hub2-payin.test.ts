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

/** Intention d'encaissement Hub2, réduite aux champs utilisés. */
function intent(over: Record<string, unknown> = {}) {
    return {
        id: 'pi_QW2d6JnqiatcH8KhK0mD1',
        merchantId: 'marchand-test',
        token: 'eyJhbGciOiJIUzI1NiJ9.jeton-de-test',
        purchaseReference: 'ENC-2026-00042',
        customerReference: '22370000000',
        status: 'payment_required',
        amount: 15_000,
        currency: 'XOF',
        mode: 'sandbox',
        createdAt: '2026-08-05T10:00:00.000Z',
        payments: [],
        ...over,
    };
}

/** Une tentative de paiement portée par l'intention. */
function payment(over: Record<string, unknown> = {}) {
    return {
        id: 'pay_GBc53h6dHvuuq4vlcP6dY',
        intentId: 'pi_QW2d6JnqiatcH8KhK0mD1',
        status: 'pending',
        amount: 15_000,
        currency: 'XOF',
        method: 'mobile_money',
        country: 'ML',
        provider: 'orange',
        createdAt: '2026-08-05T10:00:01.000Z',
        fees: [],
        ...over,
    };
}

const COLLECT: PaymentRequest = {
    reference: 'ENC-2026-00042',
    direction: 'payin',
    amount: Money.major(15_000, 'XOF'),
    account: { rail: 'mobile_money', country: 'ML', identifier: '22370000000', institution: 'Orange' },
};

/** File d'attente d'un encaissement nominal : recherche vide, création, tentative. */
function nominal(attempt: Record<string, unknown>): Queued[] {
    return [
        { status: 200, body: [] },
        { status: 201, body: intent() },
        { status: 201, body: intent(attempt) },
    ];
}

/**
 * File d'attente d'un `fetchStatus` d'encaissement.
 *
 * `fetchStatus` ne connaît pas le sens de l'opération : il interroge d'abord
 * les virements, puis les intentions. La liste de virements vide est donc une
 * étape obligée du parcours, pas un détail de mise en scène.
 */
function viaStatus(over: Record<string, unknown>): Queued[] {
    return [
        { status: 200, body: [] },
        { status: 200, body: [intent(over)] },
    ];
}

/* ------------------------------------------------------------------ *
 * Le parcours
 * ------------------------------------------------------------------ */

describe('Hub2 encaissement — l’enchaînement', () => {
    test('crée l’intention puis lance la tentative, en une seule invocation', async () => {
        const { provider, calls } = hub2(nominal({
            status: 'action_required',
            payments: [payment()],
            nextAction: { type: 'otp', message: 'Saisissez le code reçu par SMS' },
        }));
        await provider.execute(COLLECT);

        assert.equal(calls.length, 3);
        // 1. On regarde si la référence est déjà connue.
        assert.match(calls[0]?.url ?? '', /\/payment-intents\?purchaseReference=ENC-2026-00042$/);
        assert.equal(calls[0]?.method, 'GET');
        // 2. Création de l'intention.
        assert.equal(calls[1]?.method, 'POST');
        assert.match(calls[1]?.url ?? '', /\/payment-intents$/);
        // 3. Tentative sur cette intention.
        assert.equal(calls[2]?.method, 'POST');
        assert.match(calls[2]?.url ?? '', /\/payment-intents\/pi_QW2d6JnqiatcH8KhK0mD1\/payments$/);
    });

    test('la référence applicative devient purchaseReference', async () => {
        const { provider, calls } = hub2(nominal({ status: 'processing', payments: [payment()] }));
        await provider.execute(COLLECT);

        const body = calls[1]?.body as Record<string, unknown>;
        // C'est par elle qu'on retrouvera l'opération après un timeout.
        assert.equal(body['purchaseReference'], 'ENC-2026-00042');
        assert.equal(body['amount'], 15_000, 'unités mineures, sans conversion');
        assert.equal(body['currency'], 'XOF');
    });

    test('à défaut d’identifiant client, le numéro du payeur en tient lieu', async () => {
        const { provider, calls } = hub2(nominal({ status: 'processing', payments: [payment()] }));
        await provider.execute(COLLECT);
        // `customerReference` est obligatoire côté Hub2.
        assert.equal((calls[1]?.body as Record<string, unknown>)['customerReference'], '22370000000');
    });

    test('un identifiant client fourni est préféré', async () => {
        const { provider, calls } = hub2(nominal({ status: 'processing', payments: [payment()] }));
        await provider.execute({ ...COLLECT, metadata: { customerReference: 'cust_01924059' } });
        assert.equal((calls[1]?.body as Record<string, unknown>)['customerReference'], 'cust_01924059');
    });

    test('la tentative porte le jeton, l’opérateur en minuscules et le numéro', async () => {
        const { provider, calls } = hub2(nominal({ status: 'processing', payments: [payment()] }));
        await provider.execute(COLLECT);

        const body = calls[2]?.body as Record<string, unknown>;
        assert.equal(body['token'], 'eyJhbGciOiJIUzI1NiJ9.jeton-de-test');
        assert.equal(body['paymentMethod'], 'mobile_money');
        assert.equal(body['country'], 'ML');
        assert.equal(body['provider'], 'orange');
        assert.deepEqual(body['mobileMoney'], { msisdn: '+22370000000' });
    });

    test('un OTP fourni d’avance évite l’aller-retour', async () => {
        const { provider, calls } = hub2(nominal({ status: 'successful', payments: [payment({ status: 'successful' })] }));
        const res = await provider.execute({ ...COLLECT, metadata: { otp: '1234' } });

        const mm = (calls[2]?.body as Record<string, unknown>)['mobileMoney'] as Record<string, unknown>;
        assert.equal(mm['otp'], '1234');
        assert.equal(res.status, 'succeeded');
    });
});

/* ------------------------------------------------------------------ *
 * Ce que le client doit faire
 * ------------------------------------------------------------------ */

describe('Hub2 encaissement — la consigne au client', () => {
    test('action_required n’est ni un succès ni un échec', async () => {
        const { provider } = hub2(nominal({
            status: 'action_required',
            payments: [payment()],
            nextAction: { type: 'otp', message: 'Saisissez le code reçu par SMS' },
        }));
        const res = await provider.execute(COLLECT);

        // Le confondre avec `processing` ferait interroger en boucle un
        // paiement qui n'avancera jamais tout seul.
        assert.equal(res.status, 'action_required');
        assert.deepEqual(res.action, { type: 'otp', message: 'Saisissez le code reçu par SMS' });
    });

    test('une consigne USSD est transmise telle quelle', async () => {
        const { provider } = hub2(nominal({
            status: 'action_required',
            payments: [payment()],
            nextAction: { type: 'ussd', message: 'Composez #144*82# puis validez' },
        }));
        const res = await provider.execute(COLLECT);

        // Le message porte la syntaxe exacte : impossible à deviner.
        assert.equal(res.action?.type, 'ussd');
        assert.equal(res.action?.message, 'Composez #144*82# puis validez');
    });

    test('une redirection expose l’adresse et le verbe', async () => {
        const { provider } = hub2(nominal({
            status: 'action_required',
            payments: [payment()],
            nextAction: {
                type: 'redirection',
                message: 'Finalisez le paiement sur la page de l’opérateur',
                data: { url: 'https://pay.orange.ml/abc', method: 'post', data: { ref: 'abc' } },
            },
        }));
        const res = await provider.execute(COLLECT);

        assert.equal(res.action?.type, 'redirect');
        assert.equal(res.action?.type === 'redirect' && res.action.url, 'https://pay.orange.ml/abc');
        assert.equal(res.action?.type === 'redirect' && res.action.method, 'post');
    });

    test('une redirection sans adresse n’invente pas de consigne', async () => {
        const { provider } = hub2(nominal({
            status: 'action_required',
            payments: [payment()],
            nextAction: { type: 'redirection', message: 'Suivez le lien', data: {} },
        }));
        const res = await provider.execute(COLLECT);

        // Envoyer le client vers le vide est pire que ne rien dire.
        assert.equal(res.status, 'action_required');
        assert.equal(res.action, undefined);
    });

    test('aucune action n’est annoncée quand rien n’est attendu', async () => {
        const { provider } = hub2(nominal({ status: 'processing', payments: [payment()] }));
        const res = await provider.execute(COLLECT);
        assert.equal(res.status, 'processing');
        assert.equal(res.action, undefined);
    });
});

/* ------------------------------------------------------------------ *
 * Confirmation de l'OTP
 * ------------------------------------------------------------------ */

describe('Hub2 encaissement — confirm()', () => {
    test('retrouve l’intention et transmet le code', async () => {
        const { provider, calls } = hub2([
            { status: 200, body: [intent({ status: 'action_required', payments: [payment()] })] },
            { status: 201, body: intent({ status: 'successful', payments: [payment({ status: 'successful' })] }) },
        ]);
        const res = await provider.confirm('ENC-2026-00042', '1234');

        assert.match(calls[1]?.url ?? '', /\/payment-intents\/pi_QW2d6JnqiatcH8KhK0mD1\/authentication$/);
        assert.deepEqual(calls[1]?.body, {
            token: 'eyJhbGciOiJIUzI1NiJ9.jeton-de-test',
            confirmationCode: '1234',
        });
        assert.equal(res.status, 'succeeded');
    });

    test('un code refusé donne wrong_pin, sans détruire l’intention', async () => {
        const { provider } = hub2([
            { status: 200, body: [intent({ status: 'action_required', payments: [payment()] })] },
            {
                status: 201,
                body: intent({
                    status: 'action_required',
                    payments: [payment({ status: 'failed' })],
                    lastPaymentFailure: { code: 'authentication_failed', message: 'Code incorrect' },
                }),
            },
        ]);
        const res = await provider.confirm('ENC-2026-00042', '0000');

        assert.equal(res.error?.code, 'wrong_pin');
        // L'intention survit : le client peut retenter avec le bon code.
        assert.equal(res.status, 'action_required');
    });

    test('l’OTP n’est JAMAIS rejoué automatiquement', async () => {
        const { provider, calls } = hub2([
            { status: 200, body: [intent({ status: 'action_required', payments: [payment()] })] },
            { status: 503 },
        ]);
        await assert.rejects(() => provider.confirm('ENC-2026-00042', '1234'));
        // Un OTP se consomme. Le rejouer, c'est le brûler pour rien.
        assert.equal(calls.length, 2);
    });

    test('confirmer une référence inconnue lève', async () => {
        const { provider } = hub2([{ status: 200, body: [] }]);
        await assert.rejects(
            () => provider.confirm('ENC-INEXISTANT', '1234'),
            (e: PaymentError) => e.code === 'invalid_request'
        );
    });
});

/* ------------------------------------------------------------------ *
 * Ce qui protège l'argent du client
 * ------------------------------------------------------------------ */

describe('Hub2 encaissement — idempotence', () => {
    test('une référence déjà tentée n’est PAS retentée', async () => {
        const { provider, calls } = hub2([
            {
                status: 200,
                body: [intent({ status: 'action_required', payments: [payment()], nextAction: { type: 'otp', message: 'code' } })],
            },
        ]);
        const res = await provider.execute(COLLECT);

        // Sans cette lecture préalable, le client serait débité deux fois.
        assert.equal(calls.length, 1, 'aucune création, aucune tentative');
        assert.equal(res.status, 'action_required');
        assert.equal(res.providerReference, 'pi_QW2d6JnqiatcH8KhK0mD1');
    });

    test('une intention existante SANS tentative est réutilisée', async () => {
        const { provider, calls } = hub2([
            { status: 200, body: [intent({ status: 'payment_required', payments: [] })] },
            { status: 201, body: intent({ status: 'processing', payments: [payment()] }) },
        ]);
        const res = await provider.execute(COLLECT);

        // On ne crée pas de doublon : on reprend l'intention en cours.
        assert.equal(calls.length, 2);
        assert.equal(calls[1]?.method, 'POST');
        assert.match(calls[1]?.url ?? '', /\/payments$/);
        assert.equal(res.status, 'processing');
    });

    test('une tentative n’est jamais rejouée sur 503', async () => {
        const { provider, calls } = hub2([
            { status: 200, body: [] },
            { status: 201, body: intent() },
            { status: 503 },
        ]);
        await assert.rejects(
            () => provider.execute(COLLECT),
            (e: PaymentError) => e.code === 'provider_unavailable'
        );
        assert.equal(calls.length, 3, 'un seul POST de tentative');
    });

    test('un timeout sur la tentative impose la réconciliation', async () => {
        const { provider } = hub2([
            { status: 200, body: [] },
            { status: 201, body: intent() },
            'abort',
        ]);
        await assert.rejects(
            () => provider.execute(COLLECT),
            (e: PaymentError) => e.code === 'network_timeout' && e.needsReconciliation && !e.retryable
        );
    });
});

/* ------------------------------------------------------------------ *
 * Statuts et échecs
 * ------------------------------------------------------------------ */

describe('Hub2 encaissement — statuts', () => {
    const cas: [string, string][] = [
        ['payment_required', 'pending'],
        ['action_required', 'action_required'],
        ['processing', 'processing'],
        ['successful', 'succeeded'],
        ['failed', 'failed'],
        ['canceled', 'failed'],
    ];

    for (const [hub2Status, attendu] of cas) {
        test(`${hub2Status} devient ${attendu}`, async () => {
            const { provider } = hub2(viaStatus({ status: hub2Status, payments: [payment()] }));
            const res = await provider.fetchStatus('ENC-2026-00042');
            assert.equal(res.status, attendu);
        });
    }

    test('canceled sans cause détaillée devient un refus du client', async () => {
        const { provider } = hub2(viaStatus({ status: 'canceled', payments: [payment()] }));
        const res = await provider.fetchStatus('ENC-2026-00042');

        assert.equal(res.status, 'failed');
        assert.equal(res.error?.code, 'customer_declined');
        assert.equal(res.error?.providerCode, 'canceled');
    });

    test('un statut inconnu lève plutôt que d’être deviné', async () => {
        const { provider } = hub2(viaStatus({ status: 'en_attente_de_quelque_chose' }));
        await assert.rejects(
            () => provider.fetchStatus('ENC-2026-00042'),
            (e: PaymentError) => e.code === 'provider_error'
        );
    });
});

describe('Hub2 encaissement — les causes d’échec du client', () => {
    const cas: [string, string][] = [
        ['customer_insufficient_funds', 'insufficient_funds'],
        ['customer_account_locked', 'account_blocked'],
        ['authentication_failed', 'wrong_pin'],
        ['canceled_by_customer', 'customer_declined'],
        ['payer_quota_exceeded', 'account_limit_exceeded'],
        ['msisdn_invalid', 'invalid_account'],
        ['card_cvn_invalid', 'wrong_pin'],
        ['timeout', 'network_timeout'],
        ['too_many_request', 'rate_limited'],
    ];

    for (const [hub2Code, attendu] of cas) {
        test(`${hub2Code} devient ${attendu}`, async () => {
            const { provider } = hub2(viaStatus({
                status: 'failed',
                payments: [payment({ status: 'failed' })],
                lastPaymentFailure: { code: hub2Code, message: 'x' },
            }));
            const res = await provider.fetchStatus('ENC-2026-00042');
            assert.equal(res.error?.code, attendu);
            assert.equal(res.error?.providerCode, hub2Code, 'le code brut survit pour le support');
        });
    }

    test('le message de Hub2 est repris — il est écrit pour le client', async () => {
        const { provider } = hub2(viaStatus({
            status: 'failed',
            payments: [payment({ status: 'failed' })],
            lastPaymentFailure: { code: 'customer_insufficient_funds', message: 'Solde Orange Money insuffisant' },
        }));
        const res = await provider.fetchStatus('ENC-2026-00042');
        assert.equal(res.error?.message, 'Solde Orange Money insuffisant');
    });

    test('une cause inconnue tombe sur `unknown` sans perdre le code brut', async () => {
        const { provider } = hub2(viaStatus({
            status: 'failed',
            payments: [payment({ status: 'failed' })],
            lastPaymentFailure: { code: 'cause_inedite', message: 'x' },
        }));
        const res = await provider.fetchStatus('ENC-2026-00042');
        assert.equal(res.error?.code, 'unknown');
        assert.equal(res.error?.providerCode, 'cause_inedite');
    });
});

/* ------------------------------------------------------------------ *
 * Refus en amont
 * ------------------------------------------------------------------ */

describe('Hub2 encaissement — ce qui est refusé sans appeler le réseau', () => {
    test('la carte bancaire est hors périmètre', async () => {
        const { provider, calls } = hub2([]);
        await assert.rejects(
            () => provider.execute({
                ...COLLECT,
                account: { ...COLLECT.account, rail: 'card' },
            }),
            (e: PaymentError) => e.code === 'unsupported_corridor'
        );
        assert.equal(calls.length, 0);
    });

    test('l’opérateur reste obligatoire', async () => {
        const { provider, calls } = hub2([]);
        await assert.rejects(
            () => provider.execute({
                ...COLLECT,
                account: { ...COLLECT.account, institution: undefined },
            }),
            (e: PaymentError) => e.code === 'invalid_request'
        );
        assert.equal(calls.length, 0);
    });

    test('une référence à caractères interdits est refusée en amont', async () => {
        const { provider, calls } = hub2([]);
        await assert.rejects(
            () => provider.execute({ ...COLLECT, reference: 'ENC/2026#42' }),
            (e: PaymentError) => e.code === 'invalid_request'
        );
        assert.equal(calls.length, 0);
    });

    test('un montant nul est refusé', async () => {
        const { provider, calls } = hub2([]);
        await assert.rejects(
            () => provider.execute({ ...COLLECT, amount: Money.zero('XOF') }),
            (e: PaymentError) => e.code === 'invalid_request'
        );
        assert.equal(calls.length, 0);
    });
});

/* ------------------------------------------------------------------ *
 * Redirections et Orange
 * ------------------------------------------------------------------ */

describe('Hub2 encaissement — options de parcours', () => {
    test('les adresses de retour sont transmises', async () => {
        const { provider, calls } = hub2(
            nominal({ status: 'processing', payments: [payment()] }),
            {
                redirection: {
                    onSuccess: 'https://exemple.ml/ok',
                    onFailed: 'https://exemple.ml/ko',
                    onCancel: 'https://exemple.ml/annule',
                    onFinish: 'https://exemple.ml/fin',
                },
            }
        );
        await provider.execute(COLLECT);

        const mm = (calls[2]?.body as Record<string, unknown>)['mobileMoney'] as Record<string, unknown>;
        assert.equal(mm['onSuccessRedirectionUrl'], 'https://exemple.ml/ok');
        assert.equal(mm['onFailedRedirectionUrl'], 'https://exemple.ml/ko');
        // Ces deux-là sont propres à Orange.
        assert.equal(mm['onCancelRedirectionUrl'], 'https://exemple.ml/annule');
        assert.equal(mm['onFinishRedirectionUrl'], 'https://exemple.ml/fin');
    });

    test('les options propres à Orange ne partent pas chez un autre opérateur', async () => {
        const { provider, calls } = hub2(
            nominal({ status: 'processing', payments: [payment()] }),
            { orangeWorkflow: 'redirection', redirection: { onCancel: 'https://exemple.ml/annule' } }
        );
        await provider.execute({
            ...COLLECT,
            account: { ...COLLECT.account, institution: 'mobicash' },
        });

        const mm = (calls[2]?.body as Record<string, unknown>)['mobileMoney'] as Record<string, unknown>;
        assert.equal(mm['workflow'], undefined);
        assert.equal(mm['onCancelRedirectionUrl'], undefined);
    });

    test('le parcours Orange par redirection est demandé explicitement', async () => {
        const { provider, calls } = hub2(
            nominal({ status: 'processing', payments: [payment()] }),
            { orangeWorkflow: 'redirection' }
        );
        await provider.execute(COLLECT);

        const mm = (calls[2]?.body as Record<string, unknown>)['mobileMoney'] as Record<string, unknown>;
        assert.equal(mm['workflow'], 'redirection');
    });
});

/* ------------------------------------------------------------------ *
 * Réconciliation et webhooks
 * ------------------------------------------------------------------ */

describe('Hub2 encaissement — réconciliation', () => {
    test('fetchStatus cherche le virement puis l’encaissement', async () => {
        const { provider, calls } = hub2([
            { status: 200, body: [] },                                    // aucun virement
            { status: 200, body: [intent({ status: 'successful', payments: [payment()] })] },
        ]);
        const res = await provider.fetchStatus('ENC-2026-00042');

        assert.match(calls[0]?.url ?? '', /\/transfers\?reference=/);
        assert.match(calls[1]?.url ?? '', /\/payment-intents\?purchaseReference=/);
        assert.equal(res.status, 'succeeded');
    });

    test('une référence inconnue des deux côtés lève', async () => {
        const { provider } = hub2([{ status: 200, body: [] }]);
        await assert.rejects(
            () => provider.fetchStatus('INEXISTANT'),
            (e: PaymentError) => e.code === 'invalid_request'
        );
    });

    test('les frais retenus sont ceux de la dernière tentative', async () => {
        const { provider } = hub2(viaStatus({
            status: 'successful',
            payments: [
                payment({ id: 'pay_1', status: 'failed', createdAt: '2026-08-05T10:00:01.000Z', fees: [{ amount: 999, currency: 'XOF' }] }),
                payment({ id: 'pay_2', status: 'successful', createdAt: '2026-08-05T10:05:00.000Z', fees: [{ amount: 225, currency: 'XOF' }] }),
            ],
        }));
        const res = await provider.fetchStatus('ENC-2026-00042');
        // Une tentative échouée ne coûte rien : seule la dernière compte.
        assert.equal(res.fee?.amount, 225);
    });
});

describe('Hub2 encaissement — webhooks', () => {
    function event(over: Record<string, unknown> = {}) {
        return JSON.stringify({
            id: 'evt_2',
            type: 'payment_intent.succeeded',
            owner: 'marchand-test',
            test: true,
            createdAt: '2026-08-05T10:05:00.000Z',
            data: intent({ status: 'successful', payments: [payment({ status: 'successful' })] }),
            ...over,
        });
    }

    test('un événement d’intention est normalisé', () => {
        const { provider } = hub2([]);
        const e = provider.parseWebhook(event(), {});

        assert.equal(e?.reference, 'ENC-2026-00042');
        assert.equal(e?.status, 'succeeded');
        assert.equal(e?.providerReference, 'pi_QW2d6JnqiatcH8KhK0mD1');
    });

    test('action_required arrive aussi par webhook', () => {
        const { provider } = hub2([]);
        const e = provider.parseWebhook(event({
            type: 'payment_intent.action_required',
            data: intent({
                status: 'action_required',
                payments: [payment()],
                nextAction: { type: 'otp', message: 'code' },
            }),
        }), {});
        assert.equal(e?.status, 'action_required');
    });

    test('un échec porte sa cause normalisée', () => {
        const { provider } = hub2([]);
        const e = provider.parseWebhook(event({
            type: 'payment_intent.payment_failed',
            data: intent({
                status: 'failed',
                payments: [payment({ status: 'failed' })],
                lastPaymentFailure: { code: 'customer_insufficient_funds', message: 'Solde insuffisant' },
            }),
        }), {});

        assert.equal(e?.status, 'failed');
        assert.equal(e?.error?.code, 'insufficient_funds');
    });

    test('sans purchaseReference, l’événement est rejeté', () => {
        const { provider } = hub2([]);
        const orphelin = JSON.stringify({
            type: 'payment_intent.succeeded',
            data: { id: 'pi_x', status: 'successful' },
        });
        // Sans référence applicative, impossible de rattacher l'événement.
        assert.equal(provider.parseWebhook(orphelin, {}), null);
    });

    test('le statut de l’objet prime sur le type d’événement', () => {
        const { provider } = hub2([]);
        const incoherent = event({
            type: 'payment_intent.succeeded',
            data: intent({ status: 'processing', payments: [payment()] }),
        });
        assert.equal(provider.parseWebhook(incoherent, {})?.status, 'processing');
    });
});

/* ------------------------------------------------------------------ *
 * Routage
 * ------------------------------------------------------------------ */

describe('Hub2 encaissement — routage', () => {
    test('le routeur distingue les deux sens sur le même corridor', () => {
        const { provider } = hub2([]);
        const router = new Router([provider]);

        const base = {
            rail: 'mobile_money' as const, country: 'ML', currency: 'XOF' as const,
            amount: 15_000, institution: 'orange',
        };
        assert.equal(router.resolve({ ...base, direction: 'payin' })?.name, 'hub2');
        assert.equal(router.resolve({ ...base, direction: 'payout' })?.name, 'hub2');
    });

    test('un corridor non couvert reste refusé dans les deux sens', () => {
        const { provider } = hub2([]);
        const router = new Router([provider]);
        assert.equal(
            router.resolve({
                rail: 'mobile_money', country: 'NE', currency: 'XOF',
                direction: 'payin', amount: 15_000,
            }),
            null,
            'Hub2 ne dessert pas le Niger'
        );
    });
});
