import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    redact, scrubPath, maskIdentifier, safeObserver, composeObservers, jsonObserver,
} from '../src/core/observability.ts';
import type { Observation } from '../src/core/observability.ts';

describe('Redaction — aucun secret ne sort', () => {
    test('les clés d’API et jetons sont supprimés, pas tronqués', () => {
        const out = redact({
            ApiKey: 'sk_live_tres_secret',
            api_key: 'autre',
            MerchantId: 'm_123',
            token: 'jeton',
            Authorization: 'Bearer abc',
            confirmationCode: '1234',
            otp: '9999',
        }) as Record<string, unknown>;

        for (const key of Object.keys(out)) {
            assert.equal(out[key], '[secret]', `${key} doit être masqué`);
        }
        // Rien ne doit laisser filtrer un fragment exploitable.
        assert.ok(!JSON.stringify(out).includes('sk_live'));
    });

    test('la détection est insensible à la casse et au préfixe', () => {
        const out = redact({ hub2ApiKey: 'x', MY_SECRET_THING: 'y', webhookSignature: 'z' }) as Record<string, unknown>;
        assert.equal(out['hub2ApiKey'], '[secret]');
        assert.equal(out['MY_SECRET_THING'], '[secret]');
        assert.equal(out['webhookSignature'], '[secret]');
    });

    test('les données personnelles sont MASQUÉES, pas supprimées — le support doit pouvoir rapprocher', () => {
        const out = redact({
            msisdn: '+22370123456',
            holderName: 'Awa Traoré',
            email: 'awa@exemple.ml',
        }) as Record<string, unknown>;

        assert.equal(out['msisdn'], '223…3456');
        assert.equal(out['holderName'], 'A. T.');
        assert.equal(out['email'], '…@exemple.ml');
    });

    test('un numéro trop court ne laisse rien passer', () => {
        assert.equal(maskIdentifier('1234'), '…');
        assert.equal(maskIdentifier('22370123456'), '223…3456');
    });

    test('la descente est bornée en profondeur', () => {
        const profond = { a: { b: { c: { d: { e: { f: { g: 'trop loin' } } } } } } };
        const out = JSON.stringify(redact(profond, { maxDepth: 3 }));
        assert.ok(!out.includes('trop loin'));
        assert.ok(out.includes('profondeur maximale'));
    });

    test('les tableaux sont tronqués avec mention du reste', () => {
        const out = redact(Array.from({ length: 50 }, (_, i) => i), { maxArray: 5 }) as unknown[];
        assert.equal(out.length, 6);
        assert.equal(out[5], '…45 éléments omis');
    });

    test('les chaînes trop longues sont coupées', () => {
        const out = redact({ body: 'x'.repeat(5_000) }, { maxString: 10 }) as Record<string, string>;
        assert.ok(out['body']?.endsWith('…[tronqué]'));
        assert.equal(out['body']?.length, 10 + '…[tronqué]'.length);
    });

    test('un cycle ne fait pas exploser la pile', () => {
        const a: Record<string, unknown> = { nom: 'a' };
        a['soi'] = a;
        const out = redact(a) as Record<string, unknown>;
        assert.equal(out['soi'], '[cycle]');
    });

    test('une Error devient lisible sans sa pile', () => {
        const out = redact({ cause: new TypeError('cassé') }) as Record<string, Record<string, unknown>>;
        assert.deepEqual(out['cause'], { name: 'TypeError', message: 'cassé' });
    });

    test('la valeur d’origine n’est jamais modifiée', () => {
        const source = { apiKey: 'secret', msisdn: '+22370123456' };
        redact(source);
        assert.equal(source.apiKey, 'secret');
        assert.equal(source.msisdn, '+22370123456');
    });

    test('des champs secrets supplémentaires peuvent être déclarés', () => {
        const out = redact({ codeMaison: 'x' }, { extraSecretKeys: ['codemaison'] }) as Record<string, unknown>;
        assert.equal(out['codeMaison'], '[secret]');
    });
});

describe('Chemins HTTP — pas de référence métier dans les journaux d’accès', () => {
    test('la chaîne de requête est retirée', () => {
        assert.equal(scrubPath('/payment-intents?purchaseReference=CMD-42'), '/payment-intents');
        assert.equal(scrubPath('/transfers'), '/transfers');
    });
});

describe('Observer — un journal cassé ne casse pas un paiement', () => {
    test('une exception de l’observateur est avalée', () => {
        const bavard = safeObserver(() => { throw new Error('agent de collecte mort'); });
        assert.doesNotThrow(() => bavard({ kind: 'http.request', at: 1 }));
    });

    test('un observateur absent devient silencieux', () => {
        assert.doesNotThrow(() => safeObserver(undefined)({ kind: 'http.request', at: 1 }));
    });

    test('la composition diffuse à tous, même si l’un échoue', () => {
        const vus: string[] = [];
        const observer = composeObservers(
            () => { throw new Error('celui-là est mort'); },
            (o) => vus.push(o.kind),
            (o) => vus.push(`bis:${o.kind}`),
        );
        observer({ kind: 'payment.succeeded', at: 1 });
        assert.deepEqual(vus, ['payment.succeeded', 'bis:payment.succeeded']);
    });

    test('jsonObserver écrit une ligne NDJSON horodatée', () => {
        const lignes: string[] = [];
        const observation: Observation = {
            kind: 'payment.succeeded', at: Date.UTC(2026, 9, 30, 12, 0, 0), reference: 'CMD-1',
        };
        jsonObserver((l) => lignes.push(l))(observation);

        const parsed = JSON.parse(lignes[0] ?? '{}');
        assert.equal(parsed.kind, 'payment.succeeded');
        assert.equal(parsed.reference, 'CMD-1');
        assert.equal(parsed.ts, '2026-10-30T12:00:00.000Z');
    });
});
