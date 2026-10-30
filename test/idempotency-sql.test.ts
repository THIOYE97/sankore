import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SqlIdempotencyStore, withIdempotency, ReconciliationRequiredError, DuplicateInFlightError } from '../src/core/idempotency.ts';
import { PaymentError } from '../src/core/errors.ts';
import { MYSQL_PLACEHOLDER } from '../src/core/sql.ts';
import type { SqlResult, SqlRunner } from '../src/core/sql.ts';

/**
 * Base simulée, assez fidèle pour tester ce qui compte : l'atomicité vient de
 * l'INSERT, pas du code appelant. Un faux pilote qui laisserait passer deux
 * insertions de la même clé rendrait tout ce fichier inutile.
 */
function fakeDb() {
    interface Row { key: string; state: string; result?: string | undefined; error?: string | undefined; created_at: string }
    const table = new Map<string, Row>();
    const sqls: string[] = [];

    const run: SqlRunner = async (sql, params): Promise<SqlResult> => {
        sqls.push(sql);
        const p = params as unknown[];

        if (sql.startsWith('DELETE') && sql.includes('created_at <') && sql.includes('key =')) {
            const [key, cutoff] = p as [string, string];
            const row = table.get(key);
            if (row && row.created_at < cutoff) { table.delete(key); return { rows: [], affected: 1 }; }
            return { rows: [], affected: 0 };
        }
        if (sql.startsWith('DELETE') && sql.includes('state IN')) {
            const [cutoff] = p as [string];
            let n = 0;
            for (const [k, row] of table) {
                if ((row.state === 'completed' || row.state === 'in_flight') && row.created_at < cutoff) {
                    table.delete(k); n++;
                }
            }
            return { rows: [], affected: n };
        }
        if (sql.startsWith('DELETE')) {
            const [key] = p as [string];
            return { rows: [], affected: table.delete(key) ? 1 : 0 };
        }
        if (sql.startsWith('INSERT')) {
            const [key, at] = p as [string, string];
            if (table.has(key)) return { rows: [], affected: 0 };   // ON CONFLICT DO NOTHING
            table.set(key, { key, state: 'in_flight', created_at: at });
            return { rows: [], affected: 1 };
        }
        if (sql.startsWith('UPDATE') && sql.includes("'completed'")) {
            const [key, result] = p as [string, string];
            const row = table.get(key);
            if (!row) return { rows: [], affected: 0 };
            table.set(key, { ...row, state: 'completed', result, error: undefined });
            return { rows: [], affected: 1 };
        }
        if (sql.startsWith('UPDATE') && sql.includes("'needs_reconciliation'")) {
            const [key, error] = p as [string, string];
            const row = table.get(key);
            if (!row) return { rows: [], affected: 0 };
            table.set(key, { ...row, state: 'needs_reconciliation', error });
            return { rows: [], affected: 1 };
        }
        if (sql.startsWith('SELECT') && sql.includes("state = 'needs_reconciliation'")) {
            const rows = [...table.values()]
                .filter((r) => r.state === 'needs_reconciliation')
                .sort((a, b) => a.created_at.localeCompare(b.created_at))
                .map((r) => ({ ...r } as unknown as Record<string, unknown>));
            return { rows, affected: rows.length };
        }
        if (sql.startsWith('SELECT')) {
            const [key] = p as [string];
            const row = table.get(key);
            return { rows: row ? [{ ...row } as unknown as Record<string, unknown>] : [], affected: row ? 1 : 0 };
        }
        return { rows: [], affected: 0 };
    };

    return { run, table, sqls };
}

describe('Store SQL — réservation atomique', () => {
    test('la première réservation passe, la seconde voit l’enregistrement', async () => {
        const db = fakeDb();
        const store = new SqlIdempotencyStore({ run: db.run });

        assert.equal(await store.reserve('CMD-1', 60_000), null, 'voie libre');
        const second = await store.reserve('CMD-1', 60_000);
        assert.equal(second?.state, 'in_flight');
    });

    test('c’est l’INSERT qui arbitre, pas un SELECT préalable', async () => {
        const db = fakeDb();
        await new SqlIdempotencyStore({ run: db.run }).reserve('CMD-1', 60_000);

        const insert = db.sqls.find((s) => s.startsWith('INSERT'));
        assert.ok(insert?.includes('ON CONFLICT (key) DO NOTHING'));
    });

    test('un verrou périmé est reconduit — une référence légitime ne reste pas bloquée', async () => {
        let t = Date.UTC(2026, 0, 1);
        const db = fakeDb();
        const store = new SqlIdempotencyStore({ run: db.run, now: () => t });

        await store.reserve('CMD-1', 1_000);
        t += 5_000;
        assert.equal(await store.reserve('CMD-1', 1_000), null, 'le verrou mort a été purgé');
    });
});

describe('Store SQL — les trois états', () => {
    test('complete mémorise le résultat et efface l’erreur', async () => {
        const db = fakeDb();
        const store = new SqlIdempotencyStore({ run: db.run });

        await store.reserve('CMD-1', 60_000);
        await store.markForReconciliation('CMD-1', { code: 'network_timeout', message: 'rien' });
        await store.complete('CMD-1', { reference: 'CMD-1', status: 'succeeded', providerReference: 'tr_1' });

        const rec = await store.get('CMD-1');
        assert.equal(rec?.state, 'completed');
        assert.equal(rec?.result?.providerReference, 'tr_1');
        assert.equal(rec?.error, undefined);
    });

    test('markForReconciliation garde la clé PRISE', async () => {
        const db = fakeDb();
        const store = new SqlIdempotencyStore({ run: db.run });

        await store.reserve('CMD-1', 60_000);
        await store.markForReconciliation('CMD-1', {
            code: 'network_timeout', message: 'pas de réponse', provider: 'hub2',
        });

        const rec = await store.get('CMD-1');
        assert.equal(rec?.state, 'needs_reconciliation');
        assert.equal(rec?.error?.code, 'network_timeout');
        assert.equal(rec?.error?.provider, 'hub2');

        const encore = await store.reserve('CMD-1', 60_000);
        assert.equal(encore?.state, 'needs_reconciliation', 'la clé ne doit pas être libre');
    });

    test('un pilote qui désérialise déjà le JSON est accepté', async () => {
        // `pg` rend un objet pour une colonne jsonb ; `mysql2` rend une chaîne.
        // Les deux doivent marcher sans que l'hôte s'en préoccupe.
        const run: SqlRunner = async () => ({
            rows: [{
                key: 'CMD-1',
                state: 'completed',
                result: { reference: 'CMD-1', status: 'succeeded' },
                error: null,
                created_at: new Date().toISOString(),
            }],
            affected: 1,
        });
        const rec = await new SqlIdempotencyStore({ run }).get('CMD-1');
        assert.equal(rec?.result?.status, 'succeeded');
    });
});

describe('Store SQL — exploitation', () => {
    test('la file de réconciliation est listable, les plus anciennes d’abord', async () => {
        let t = Date.UTC(2026, 0, 1);
        const db = fakeDb();
        const store = new SqlIdempotencyStore({ run: db.run, now: () => t });

        for (const ref of ['CMD-1', 'CMD-2', 'CMD-3']) {
            await store.reserve(ref, 60_000);
            await store.markForReconciliation(ref, { code: 'network_timeout', message: 'x' });
            t += 1_000;
        }
        await store.reserve('CMD-OK', 60_000);
        await store.complete('CMD-OK', { reference: 'CMD-OK', status: 'succeeded' });

        const file = await store.pendingReconciliation();
        assert.deepEqual(file.map((r) => r.key), ['CMD-1', 'CMD-2', 'CMD-3']);
    });

    test('la purge ne touche JAMAIS aux clés à réconcilier', async () => {
        let t = Date.UTC(2026, 0, 1);
        const db = fakeDb();
        const store = new SqlIdempotencyStore({ run: db.run, now: () => t });

        await store.reserve('VIEUX-OK', 60_000);
        await store.complete('VIEUX-OK', { reference: 'VIEUX-OK', status: 'succeeded' });
        await store.reserve('VIEUX-DOUTE', 60_000);
        await store.markForReconciliation('VIEUX-DOUTE', { code: 'network_timeout', message: 'x' });

        t += 10 * 24 * 60 * 60 * 1000;
        const supprimes = await store.purge(24 * 60 * 60 * 1000);

        assert.equal(supprimes, 1);
        assert.equal(await store.get('VIEUX-OK'), null);
        assert.ok(await store.get('VIEUX-DOUTE'), 'oublier une incertitude sur de l’argent est interdit');
    });

    test('le dialecte MySQL est pris en charge', async () => {
        const db = fakeDb();
        const store = new SqlIdempotencyStore({ run: db.run, placeholder: MYSQL_PLACEHOLDER });
        await store.reserve('CMD-1', 60_000);

        assert.ok(db.sqls.some((s) => s.includes('VALUES (?,')));
        assert.ok(!db.sqls.some((s) => s.includes('$1')));
    });

    test('le nom de table est configurable', async () => {
        const db = fakeDb();
        await new SqlIdempotencyStore({ run: db.run, table: 'paiements_verrous' }).reserve('CMD-1', 60_000);
        assert.ok(db.sqls.every((s) => s.includes('paiements_verrous')));
    });
});

describe('Store SQL — bout en bout avec withIdempotency', () => {
    test('le cycle complet : échec incertain, refus de rejeu, puis clôture', async () => {
        const db = fakeDb();
        const store = new SqlIdempotencyStore({ run: db.run });

        await assert.rejects(() =>
            withIdempotency('CMD-9', { store }, async () => {
                throw new PaymentError({ code: 'network_timeout', provider: 'hub2' });
            })
        );

        await assert.rejects(
            () => withIdempotency('CMD-9', { store }, async () => ({ reference: 'CMD-9', status: 'succeeded' })),
            ReconciliationRequiredError
        );

        await store.complete('CMD-9', { reference: 'CMD-9', status: 'succeeded' });

        let relance = false;
        const res = await withIdempotency('CMD-9', { store }, async () => {
            relance = true;
            return { reference: 'CMD-9', status: 'failed' as const };
        });
        assert.equal(relance, false);
        assert.equal(res.status, 'succeeded');
    });

    test('un appel concurrent sur la même clé est refusé', async () => {
        const db = fakeDb();
        const store = new SqlIdempotencyStore({ run: db.run });

        let resoudre: (v: { reference: string; status: 'succeeded' }) => void = () => {};
        const enCours = withIdempotency('CMD-10', { store }, () => new Promise((r) => { resoudre = r; }));

        await assert.rejects(
            () => withIdempotency('CMD-10', { store }, async () => ({ reference: 'CMD-10', status: 'succeeded' })),
            DuplicateInFlightError
        );

        resoudre({ reference: 'CMD-10', status: 'succeeded' });
        await enCours;
    });
});
