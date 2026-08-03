import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, mapHttpStatus, verifyHmacSignature } from '../src/core/http.ts';
import { PaymentError } from '../src/core/errors.ts';

/** fetch factice : rend les réponses de la file, dans l'ordre. */
function fakeFetch(responses: Array<{ status: number; body?: unknown } | 'abort'>) {
    let i = 0;
    const calls = { count: 0 };
    const impl = (async () => {
        calls.count++;
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r === 'abort') {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
        }
        return new Response(JSON.stringify(r!.body ?? {}), {
            status: r!.status,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof fetch;
    return { impl, calls };
}

describe('HttpClient — traduction des statuts', () => {
    test('les statuts HTTP deviennent des codes normalisés', () => {
        assert.equal(mapHttpStatus(401), 'authentication_failed');
        assert.equal(mapHttpStatus(400), 'invalid_request');
        assert.equal(mapHttpStatus(404), 'invalid_account');
        assert.equal(mapHttpStatus(409), 'duplicate_request');
        assert.equal(mapHttpStatus(429), 'rate_limited');
        assert.equal(mapHttpStatus(503), 'provider_unavailable');
    });
});

describe('HttpClient — politique de reprise', () => {
    test('une 503 est rejouée puis réussit', async () => {
        const { impl, calls } = fakeFetch([{ status: 503 }, { status: 200, body: { ok: true } }]);
        const c = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: impl, retryBaseMs: 1 });
        const res = await c.request({ method: 'GET', path: '/p' }, 'test');
        assert.equal(res.status, 200);
        assert.equal(calls.count, 2);
    });

    test('une 400 n’est JAMAIS rejouée — la requête est fautive', async () => {
        const { impl, calls } = fakeFetch([{ status: 400 }]);
        const c = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: impl, retryBaseMs: 1 });
        await assert.rejects(
            () => c.request({ method: 'POST', path: '/p' }, 'test'),
            (e: PaymentError) => e.code === 'invalid_request'
        );
        assert.equal(calls.count, 1, 'aucune reprise sur erreur cliente');
    });

    test('un TIMEOUT n’est jamais rejoué — le paiement a pu partir', async () => {
        const { impl, calls } = fakeFetch(['abort']);
        const c = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: impl, retryBaseMs: 1 });
        await assert.rejects(
            () => c.request({ method: 'POST', path: '/pay' }, 'test'),
            (e: PaymentError) => e.code === 'network_timeout' && !e.retryable && e.needsReconciliation
        );
        assert.equal(calls.count, 1, 'un seul appel : rejouer risquerait un double paiement');
    });

    test('les reprises s’arrêtent après maxRetries', async () => {
        const { impl, calls } = fakeFetch([{ status: 503 }]);
        const c = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: impl, retryBaseMs: 1, maxRetries: 2 });
        await assert.rejects(() => c.request({ method: 'GET', path: '/p' }, 'test'));
        assert.equal(calls.count, 3, '1 tentative + 2 reprises');
    });

    test('la clé d’idempotence part en en-tête', async () => {
        let vu: Record<string, string> = {};
        const impl = (async (_u: string, init: RequestInit) => {
            vu = init.headers as Record<string, string>;
            return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch;
        const c = new HttpClient({ baseUrl: 'https://x.test', fetchImpl: impl });
        await c.request({ method: 'POST', path: '/p', idempotencyKey: 'REF-42' }, 'test');
        assert.equal(vu['idempotency-key'], 'REF-42');
    });
});

describe('Webhooks — signature HMAC', () => {
    const secret = 'secret-partage';
    const payload = '{"reference":"PAY-1","status":"succeeded"}';

    test('accepte une signature valide', async () => {
        const { createHmac } = await import('node:crypto');
        const sig = createHmac('sha256', secret).update(payload).digest('hex');
        assert.equal(await verifyHmacSignature({ payload, signature: sig, secret }), true);
    });

    test('rejette une signature falsifiée', async () => {
        assert.equal(await verifyHmacSignature({ payload, signature: 'ab'.repeat(32), secret }), false);
    });

    test('rejette une signature de longueur différente', async () => {
        assert.equal(await verifyHmacSignature({ payload, signature: 'court', secret }), false);
    });

    test('un payload modifié invalide la signature', async () => {
        const { createHmac } = await import('node:crypto');
        const sig = createHmac('sha256', secret).update(payload).digest('hex');
        const falsifie = payload.replace('succeeded', 'failed');
        assert.equal(await verifyHmacSignature({ payload: falsifie, signature: sig, secret }), false);
    });
});
