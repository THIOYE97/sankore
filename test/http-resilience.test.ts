import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, parseRetryAfter } from '../src/core/http.ts';
import { RateLimiter } from '../src/core/limiter.ts';
import { PaymentError } from '../src/core/errors.ts';
import { USER_AGENT } from '../src/core/version.ts';
import type { Observation } from '../src/core/observability.ts';

interface Call { url: string; init: RequestInit }

/** `fetch` en bouchon : scénarios joués dans l'ordre, aucun réseau. */
function stub(responses: readonly { status: number; body?: unknown; headers?: Record<string, string> }[]) {
    const calls: Call[] = [];
    let i = 0;
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        const r = responses[Math.min(i++, responses.length - 1)];
        if (!r) throw new Error('scénario épuisé');
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
            headers: {
                forEach: (fn: (v: string, k: string) => void) => {
                    for (const [k, v] of Object.entries(r.headers ?? {})) fn(v, k);
                },
            },
        } as unknown as Response;
    }) as unknown as typeof fetch;

    return { fetchImpl, calls };
}

/** Attente simulée : on enregistre les délais au lieu de les subir. */
function recorder() {
    const delays: number[] = [];
    return { delays, sleep: async (ms: number) => { delays.push(ms); } };
}

describe('Retry-After — honorer ce que le fournisseur annonce', () => {
    test('un nombre de secondes est lu', () => {
        assert.equal(parseRetryAfter('5'), 5_000);
        assert.equal(parseRetryAfter('0'), 0);
    });

    test('une date HTTP est lue', () => {
        const now = Date.UTC(2026, 9, 30, 12, 0, 0);
        assert.equal(parseRetryAfter('Fri, 30 Oct 2026 12:00:30 GMT', now), 30_000);
    });

    test('une date passée ne produit jamais un délai négatif', () => {
        const now = Date.UTC(2026, 9, 30, 12, 0, 0);
        assert.equal(parseRetryAfter('Fri, 30 Oct 2026 11:00:00 GMT', now), 0);
    });

    test('une valeur absente ou absurde est ignorée', () => {
        assert.equal(parseRetryAfter(undefined), undefined);
        assert.equal(parseRetryAfter(''), undefined);
        assert.equal(parseRetryAfter('bientôt'), undefined);
    });

    test('un 429 porte le délai annoncé jusque dans l’erreur', async () => {
        const { fetchImpl } = stub([{ status: 429, headers: { 'retry-after': '3' } }]);
        const http = new HttpClient({ baseUrl: 'https://x', fetchImpl, maxRetries: 0 });

        await assert.rejects(
            () => http.request({ method: 'GET', path: '/t' }, 'faux'),
            (e: PaymentError) => e.code === 'rate_limited' && e.retryAfterMs === 3_000
        );
    });

    test('la reprise n’a JAMAIS lieu avant le délai annoncé', async () => {
        const rec = recorder();
        const { fetchImpl } = stub([
            { status: 429, headers: { 'retry-after': '2' } },
            { status: 200, body: { ok: true } },
        ]);
        const http = new HttpClient({
            baseUrl: 'https://x', fetchImpl, maxRetries: 1,
            retryBaseMs: 10, sleep: rec.sleep,
            // Jitter au plus bas : sans le plancher du Retry-After, l'attente
            // serait quasi nulle — exactement ce qui fait suspendre une clé.
            random: () => 0,
        });

        const res = await http.request({ method: 'GET', path: '/t' }, 'faux');
        assert.equal(res.status, 200);
        assert.deepEqual(rec.delays, [2_000]);
    });
});

describe('Backoff — jitter complet', () => {
    test('l’attente est tirée au hasard sous le plafond exponentiel', async () => {
        const rec = recorder();
        const { fetchImpl } = stub([
            { status: 503 }, { status: 503 }, { status: 200, body: {} },
        ]);
        const http = new HttpClient({
            baseUrl: 'https://x', fetchImpl, maxRetries: 2,
            retryBaseMs: 100, sleep: rec.sleep, random: () => 1,
        });

        await http.request({ method: 'GET', path: '/t' }, 'faux');
        // Plafonds : 100 ms puis 200 ms. Avec random()=1, on les atteint.
        assert.deepEqual(rec.delays, [100, 200]);
    });

    test('deux clients ne repartent pas à la même milliseconde', async () => {
        const run = async (r: number) => {
            const rec = recorder();
            const { fetchImpl } = stub([{ status: 503 }, { status: 200, body: {} }]);
            const http = new HttpClient({
                baseUrl: 'https://x', fetchImpl, maxRetries: 1,
                retryBaseMs: 1_000, sleep: rec.sleep, random: () => r,
            });
            await http.request({ method: 'GET', path: '/t' }, 'faux');
            return rec.delays[0];
        };

        assert.notEqual(await run(0.1), await run(0.9), 'sans jitter, la reprise devient une seconde attaque');
    });

    test('l’attente est plafonnée', async () => {
        const rec = recorder();
        const { fetchImpl } = stub([
            { status: 503 }, { status: 503 }, { status: 503 }, { status: 200, body: {} },
        ]);
        const http = new HttpClient({
            baseUrl: 'https://x', fetchImpl, maxRetries: 3,
            retryBaseMs: 10_000, maxRetryDelayMs: 15_000, sleep: rec.sleep, random: () => 1,
        });

        await http.request({ method: 'GET', path: '/t' }, 'faux');
        assert.ok(rec.delays.every((d) => d <= 15_000), `délais : ${rec.delays.join(', ')}`);
    });
});

describe('Annulation — un appel annulé reste incertain', () => {
    test('un signal déjà annulé refuse l’appel avant tout réseau', async () => {
        const { fetchImpl, calls } = stub([{ status: 200, body: {} }]);
        const http = new HttpClient({ baseUrl: 'https://x', fetchImpl });
        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
            () => http.request({ method: 'POST', path: '/transfers', signal: controller.signal }, 'faux'),
            // `network_timeout` : non rejouable, à réconcilier. Annuler chez nous
            // n'annule pas ce que le fournisseur a peut-être déjà reçu.
            (e: PaymentError) => e.code === 'network_timeout' && e.needsReconciliation
        );
        assert.equal(calls.length, 0);
    });

    test('une annulation pendant l’attente de reprise arrête la boucle', async () => {
        const controller = new AbortController();
        const { fetchImpl, calls } = stub([{ status: 503 }, { status: 200, body: {} }]);
        const http = new HttpClient({
            baseUrl: 'https://x', fetchImpl, maxRetries: 2, retryBaseMs: 1,
            sleep: async () => { controller.abort(); },
        });

        await assert.rejects(
            () => http.request({ method: 'GET', path: '/t', signal: controller.signal }, 'faux'),
            (e: PaymentError) => e.code === 'network_timeout'
        );
        assert.equal(calls.length, 1, 'aucun appel après l’annulation');
    });

    test('le signal est transmis à fetch', async () => {
        const { fetchImpl, calls } = stub([{ status: 200, body: {} }]);
        const http = new HttpClient({ baseUrl: 'https://x', fetchImpl });
        await http.request({ method: 'GET', path: '/t', signal: new AbortController().signal }, 'faux');
        assert.ok(calls[0]?.init.signal, 'fetch doit pouvoir être interrompu');
    });
});

describe('Limiteur branché sur le client', () => {
    test('les requêtes au-delà de la rafale sont retenues chez nous', async () => {
        let t = 1_000_000;
        const delays: number[] = [];
        const limiter = new RateLimiter({
            ratePerSecond: 10, burst: 1,
            now: () => t,
            sleep: async (ms) => { delays.push(ms); t += ms; },
        });
        const { fetchImpl } = stub([{ status: 200, body: {} }]);
        const http = new HttpClient({ baseUrl: 'https://x', fetchImpl, limiter });

        await http.request({ method: 'GET', path: '/a' }, 'faux');
        await http.request({ method: 'GET', path: '/b' }, 'faux');

        assert.equal(delays.length, 1, 'la seconde requête a attendu son jeton');
    });
});

describe('En-têtes et identification', () => {
    test('le User-Agent identifie la version de Sankoré', async () => {
        const { fetchImpl, calls } = stub([{ status: 200, body: {} }]);
        const http = new HttpClient({ baseUrl: 'https://x', fetchImpl });
        await http.request({ method: 'GET', path: '/t' }, 'faux');

        const headers = calls[0]?.init.headers as Record<string, string>;
        assert.equal(headers['user-agent'], USER_AGENT);
        assert.ok(USER_AGENT.startsWith('sankore/'));
    });

    test('les en-têtes de la requête priment sur ceux du client', async () => {
        const { fetchImpl, calls } = stub([{ status: 200, body: {} }]);
        const http = new HttpClient({
            baseUrl: 'https://x', fetchImpl, defaultHeaders: { 'x-env': 'sandbox' },
        });
        await http.request({ method: 'GET', path: '/t', headers: { 'x-env': 'live' } }, 'faux');

        const headers = calls[0]?.init.headers as Record<string, string>;
        assert.equal(headers['x-env'], 'live');
    });
});

describe('Observabilité du client HTTP', () => {
    test('requête, réponse, reprise et abandon sont observables', async () => {
        const vus: Observation[] = [];
        const { fetchImpl } = stub([{ status: 503 }, { status: 503 }, { status: 503 }]);
        const http = new HttpClient({
            baseUrl: 'https://x', fetchImpl, maxRetries: 1, retryBaseMs: 1,
            sleep: async () => {}, observer: (o) => vus.push(o),
        });

        await assert.rejects(() => http.request({ method: 'GET', path: '/t' }, 'hub2'));

        assert.deepEqual(vus.map((o) => o.kind), [
            'http.request', 'http.response', 'http.retry', 'http.request', 'http.response', 'http.error',
        ]);
        const fin = vus.at(-1);
        assert.equal(fin?.provider, 'hub2');
        assert.equal(fin?.code, 'provider_unavailable');
        assert.equal(fin?.detail?.['exhausted'], true);
    });

    test('aucune référence métier ne fuit dans le chemin observé', async () => {
        const vus: Observation[] = [];
        const { fetchImpl } = stub([{ status: 200, body: [] }]);
        const http = new HttpClient({ baseUrl: 'https://x', fetchImpl, observer: (o) => vus.push(o) });

        await http.request({ method: 'GET', path: '/payment-intents?purchaseReference=CMD-SECRETE' }, 'hub2');

        for (const o of vus) {
            assert.equal(o.path, '/payment-intents');
            assert.ok(!JSON.stringify(o).includes('CMD-SECRETE'));
        }
    });

    test('un observateur qui lève ne casse pas la requête', async () => {
        const { fetchImpl } = stub([{ status: 200, body: { ok: true } }]);
        const http = new HttpClient({
            baseUrl: 'https://x', fetchImpl,
            observer: () => { throw new Error('agent de collecte mort'); },
        });

        const res = await http.request({ method: 'GET', path: '/t' }, 'faux');
        assert.equal(res.status, 200);
    });
});

describe('Codes HTTP', () => {
    test('un 404 n’accuse pas le numéro du client', async () => {
        const { fetchImpl } = stub([{ status: 404 }]);
        const http = new HttpClient({ baseUrl: 'https://x', fetchImpl, maxRetries: 0 });

        await assert.rejects(
            () => http.request({ method: 'GET', path: '/t' }, 'faux'),
            (e: PaymentError) => e.code === 'not_found'
        );
    });

    test('un timeout par requête peut être resserré', async () => {
        const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
            // On simule un fournisseur muet : on attend l'abandon.
            await new Promise((_r, rej) => {
                init.signal?.addEventListener('abort', () => {
                    const e = new Error('aborted');
                    e.name = 'AbortError';
                    rej(e);
                });
            });
            throw new Error('inatteignable');
        }) as unknown as typeof fetch;

        const http = new HttpClient({ baseUrl: 'https://x', fetchImpl, timeoutMs: 60_000 });
        await assert.rejects(
            () => http.request({ method: 'GET', path: '/t', timeoutMs: 20 }, 'faux'),
            (e: PaymentError) => e.code === 'network_timeout' && e.message.includes('20 ms')
        );
    });
});
