import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WebhookInbox, MemoryWebhookLog, SqlWebhookLog } from '../src/core/webhook.ts';
import type { PaymentProvider, WebhookEvent } from '../src/core/provider.ts';
import type { PaymentStatus } from '../src/core/status.ts';
import type { SqlResult, SqlRunner } from '../src/core/sql.ts';
import type { Observation } from '../src/core/observability.ts';

/**
 * Fournisseur minimal : il ne sait que lire des webhooks. `secret` simule une
 * signature — un corps qui ne la porte pas est refusé, comme en production.
 */
function fakeProvider(opts: { secret?: string } = {}): PaymentProvider {
    return {
        name: 'faux',
        capabilities: () => [],
        execute: async (req) => ({ reference: req.reference, status: 'processing' }),
        fetchStatus: async (reference) => ({ reference, status: 'processing' }),
        parseWebhook: (payload, headers): WebhookEvent | null => {
            if (opts.secret && headers['x-signature'] !== opts.secret) return null;
            if (typeof payload !== 'string') return null;
            let parsed: Record<string, unknown>;
            try { parsed = JSON.parse(payload) as Record<string, unknown>; } catch { return null; }
            if (typeof parsed['reference'] !== 'string' || typeof parsed['status'] !== 'string') return null;

            const event: WebhookEvent = {
                reference: parsed['reference'],
                status: parsed['status'] as PaymentStatus,
                raw: parsed,
            };
            if (typeof parsed['eventId'] === 'string') event.eventId = parsed['eventId'];
            return event;
        },
    };
}

/** Stockage applicatif simulé : référence -> statut courant. */
function appStore(initial: Record<string, PaymentStatus> = {}) {
    const state = new Map<string, PaymentStatus>(Object.entries(initial));
    const saved: { reference: string; from: PaymentStatus; to: PaymentStatus }[] = [];
    return {
        state,
        saved,
        load: async (reference: string) => state.get(reference) ?? null,
        save: async (event: WebhookEvent, from: PaymentStatus, to: PaymentStatus) => {
            state.set(event.reference, to);
            saved.push({ reference: event.reference, from, to });
        },
    };
}

const body = (o: Record<string, unknown>) => JSON.stringify(o);

describe('Webhook — signature', () => {
    test('une signature invalide est refusée en 401, sans rien modifier', async () => {
        const app = appStore({ 'CMD-1': 'processing' });
        const inbox = new WebhookInbox({ provider: fakeProvider({ secret: 'bon' }), ...app });

        const out = await inbox.handle(body({ reference: 'CMD-1', status: 'succeeded' }), { 'x-signature': 'faux' });

        assert.equal(out.decision, 'rejected');
        assert.equal(out.httpStatus, 401);
        assert.equal(app.state.get('CMD-1'), 'processing', 'rien ne doit bouger');
        assert.equal(app.saved.length, 0);
    });

    test('une charge illisible est refusée de la même manière', async () => {
        const app = appStore({ 'CMD-1': 'processing' });
        const inbox = new WebhookInbox({ provider: fakeProvider(), ...app });

        const out = await inbox.handle('ceci n’est pas du JSON', {});
        assert.equal(out.decision, 'rejected');
        assert.equal(out.httpStatus, 401);
    });
});

describe('Webhook — doublons', () => {
    test('le même identifiant d’événement n’est traité qu’une fois', async () => {
        const app = appStore({ 'CMD-1': 'processing' });
        const inbox = new WebhookInbox({ provider: fakeProvider(), ...app });
        const charge = body({ reference: 'CMD-1', status: 'succeeded', eventId: 'evt_1' });

        const premier = await inbox.handle(charge, {});
        const second = await inbox.handle(charge, {});

        assert.equal(premier.decision, 'applied');
        assert.equal(second.decision, 'replayed');
        assert.equal(second.httpStatus, 200, 'un 2xx fait cesser la réémission');
        assert.equal(app.saved.length, 1, 'les effets de bord ne doivent partir qu’une fois');
    });

    test('sans identifiant du fournisseur, l’empreinte du corps brut sert de clé', async () => {
        const app = appStore({ 'CMD-1': 'processing' });
        const inbox = new WebhookInbox({ provider: fakeProvider(), ...app });
        const charge = body({ reference: 'CMD-1', status: 'succeeded' });

        assert.equal((await inbox.handle(charge, {})).decision, 'applied');
        assert.equal((await inbox.handle(charge, {})).decision, 'replayed');
        assert.equal(app.saved.length, 1);
    });

    test('deux événements distincts passent tous les deux', async () => {
        const app = appStore({ 'CMD-1': 'pending' });
        const inbox = new WebhookInbox({ provider: fakeProvider(), ...app });

        const a = await inbox.handle(body({ reference: 'CMD-1', status: 'processing', eventId: 'evt_1' }), {});
        const b = await inbox.handle(body({ reference: 'CMD-1', status: 'succeeded', eventId: 'evt_2' }), {});

        assert.equal(a.decision, 'applied');
        assert.equal(b.decision, 'applied');
        assert.equal(app.state.get('CMD-1'), 'succeeded');
    });
});

describe('Webhook — ordre et états finaux', () => {
    test('un échec retardataire n’écrase JAMAIS un succès', async () => {
        const app = appStore({ 'CMD-1': 'succeeded' });
        const vus: Observation[] = [];
        const inbox = new WebhookInbox({ provider: fakeProvider(), ...app, observer: (o) => vus.push(o) });

        const out = await inbox.handle(body({ reference: 'CMD-1', status: 'failed', eventId: 'evt_tardif' }), {});

        assert.equal(out.decision, 'ignored');
        assert.equal(out.httpStatus, 200);
        assert.equal(app.state.get('CMD-1'), 'succeeded', 'la comptabilité ne doit pas mentir');
        assert.equal(app.saved.length, 0);

        // Le cas mérite une alerte : le fournisseur contredit nos livres.
        const ignore = vus.find((o) => o.kind === 'webhook.ignored');
        assert.equal(ignore?.detail?.['finalStateContradicted'], true);
    });

    test('le même état reçu deux fois sous deux identifiants n’est pas réappliqué', async () => {
        const app = appStore({ 'CMD-1': 'succeeded' });
        const inbox = new WebhookInbox({ provider: fakeProvider(), ...app });

        const out = await inbox.handle(body({ reference: 'CMD-1', status: 'succeeded', eventId: 'evt_2' }), {});
        assert.equal(out.decision, 'ignored');
        assert.equal(app.saved.length, 0);
    });

    test('une transition absurde est ignorée en 200, pas en erreur', async () => {
        const app = appStore({ 'CMD-1': 'failed' });
        const inbox = new WebhookInbox({ provider: fakeProvider(), ...app });

        const out = await inbox.handle(body({ reference: 'CMD-1', status: 'processing', eventId: 'evt_1' }), {});
        assert.equal(out.decision, 'ignored');
        assert.equal(out.httpStatus, 200);
    });
});

describe('Webhook — référence inconnue', () => {
    test('répond 200 et le signale, sans rien créer', async () => {
        const app = appStore();
        const vus: Observation[] = [];
        const inbox = new WebhookInbox({ provider: fakeProvider(), ...app, observer: (o) => vus.push(o) });

        const out = await inbox.handle(body({ reference: 'INCONNU', status: 'succeeded', eventId: 'evt_1' }), {});

        assert.equal(out.decision, 'unknown_reference');
        assert.equal(out.httpStatus, 200, 'insister ne la fera pas apparaître');
        assert.equal(app.saved.length, 0);
        assert.ok(vus.some((o) => o.kind === 'webhook.ignored'));
    });
});

describe('Webhook — transition appliquée', () => {
    test('save() reçoit l’état d’avant et d’après', async () => {
        const app = appStore({ 'CMD-1': 'pending' });
        const inbox = new WebhookInbox({ provider: fakeProvider(), ...app });

        const out = await inbox.handle(body({ reference: 'CMD-1', status: 'processing', eventId: 'evt_1' }), {});

        assert.equal(out.decision, 'applied');
        assert.deepEqual(app.saved, [{ reference: 'CMD-1', from: 'pending', to: 'processing' }]);
    });

    test('l’acceptation est observable', async () => {
        const app = appStore({ 'CMD-1': 'processing' });
        const vus: Observation[] = [];
        const inbox = new WebhookInbox({ provider: fakeProvider(), ...app, observer: (o) => vus.push(o) });

        await inbox.handle(body({ reference: 'CMD-1', status: 'succeeded', eventId: 'evt_1' }), {});

        const ok = vus.find((o) => o.kind === 'webhook.accepted');
        assert.equal(ok?.reference, 'CMD-1');
        assert.equal(ok?.paymentStatus, 'succeeded');
        assert.equal(ok?.detail?.['from'], 'processing');
    });
});

describe('Journal mémoire', () => {
    test('mémorise une fois et purge après expiration', async () => {
        let t = 1_000;
        const log = new MemoryWebhookLog({ now: () => t });

        assert.equal(await log.remember('evt_1', 1_000), true);
        assert.equal(await log.remember('evt_1', 1_000), false);

        t += 2_000;
        assert.equal(await log.remember('evt_1', 1_000), true, 'au-delà du TTL, l’entrée a disparu');
        assert.equal(log.size(), 1, 'la purge a bien eu lieu');
    });
});

describe('Journal SQL', () => {
    /** Faux pilote : c'est l'INSERT qui arbitre, comme en base. */
    function fakeDb() {
        const rows = new Map<string, string>();
        const sqls: string[] = [];
        const run: SqlRunner = async (sql, params): Promise<SqlResult> => {
            sqls.push(sql);
            const [id, at, cutoff] = params as [string, string, string?];
            if (sql.startsWith('INSERT')) {
                if (rows.has(id)) return { rows: [], affected: 0 };
                rows.set(id, at);
                return { rows: [], affected: 1 };
            }
            if (sql.startsWith('UPDATE')) {
                const current = rows.get(id);
                if (current !== undefined && cutoff !== undefined && current < cutoff) {
                    rows.set(id, at);
                    return { rows: [], affected: 1 };
                }
                return { rows: [], affected: 0 };
            }
            if (sql.startsWith('DELETE')) {
                let n = 0;
                for (const [k, v] of rows) if (v < id) { rows.delete(k); n++; }
                return { rows: [], affected: n };
            }
            return { rows: [], affected: 0 };
        };
        return { run, rows, sqls };
    }

    test('l’unicité est portée par la base, en un seul aller-retour', async () => {
        const db = fakeDb();
        const log = new SqlWebhookLog({ run: db.run });

        assert.equal(await log.remember('evt_1', 60_000), true);
        assert.equal(await log.remember('evt_1', 60_000), false);

        assert.ok(db.sqls[0]?.includes('ON CONFLICT'), 'c’est la contrainte qui arbitre la course');
    });

    test('un événement réémis au-delà du TTL est retraité', async () => {
        let t = 10_000_000;
        const db = fakeDb();
        const log = new SqlWebhookLog({ run: db.run, now: () => t });

        assert.equal(await log.remember('evt_1', 1_000), true);
        t += 5_000;
        assert.equal(await log.remember('evt_1', 1_000), true, 'le fournisseur réémet hors de sa fenêtre');
    });

    test('le dialecte des paramètres est configurable', async () => {
        const db = fakeDb();
        const log = new SqlWebhookLog({ run: db.run, placeholder: () => '?' });
        await log.remember('evt_1', 60_000);
        assert.ok(db.sqls[0]?.includes('(?, ?)'));
        assert.ok(!db.sqls[0]?.includes('$1'));
    });
});
