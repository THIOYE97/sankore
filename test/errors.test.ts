import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    PaymentError, customerMessage, registerCustomerMessages, availableLocales,
    isRetryable, needsReconciliation, ERROR_CODES,
} from '../src/core/errors.ts';
import type { ErrorCode } from '../src/core/errors.ts';

describe('Taxonomie — la distinction qui protège l’argent', () => {
    test('network_timeout n’est JAMAIS rejouable', () => {
        assert.equal(isRetryable('network_timeout'), false);
        assert.equal(needsReconciliation('network_timeout'), true);
    });

    test('seules les erreurs prouvant que rien n’est parti sont rejouables', () => {
        const rejouables = ERROR_CODES.filter(isRetryable);
        assert.deepEqual(rejouables, ['provider_unavailable', 'rate_limited']);
    });

    test('not_found n’exige pas de réconciliation : c’est un verdict', () => {
        assert.equal(needsReconciliation('not_found'), false);
        assert.equal(isRetryable('not_found'), false);
    });

    test('la liste des codes est complète et sans doublon', () => {
        assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
    });
});

describe('Messages client — deux langues, parce que les corridors l’imposent', () => {
    test('chaque code a un message dans chaque langue livrée', () => {
        for (const code of ERROR_CODES) {
            for (const locale of ['fr', 'en']) {
                const msg = customerMessage(code, locale);
                assert.ok(msg.length > 0, `${code}/${locale} doit avoir un message`);
                // Pas de jargon technique : le client final lit cette phrase.
                assert.ok(!msg.includes('_'), `${code}/${locale} ne doit pas exposer de code brut`);
            }
        }
    });

    test('le français est la langue par défaut', () => {
        assert.equal(customerMessage('insufficient_funds'), 'Solde insuffisant sur le compte.');
    });

    test('l’anglais sert le Nigeria et le Ghana, dont les devises sont couvertes', () => {
        assert.equal(customerMessage('wrong_pin', 'en'), 'Incorrect PIN.');
    });

    test('une étiquette régionale retombe sur sa base', () => {
        assert.equal(customerMessage('wrong_pin', 'fr-SN'), customerMessage('wrong_pin', 'fr'));
        assert.equal(customerMessage('wrong_pin', 'EN-NG'), customerMessage('wrong_pin', 'en'));
    });

    test('une langue inconnue retombe sur le français plutôt que sur rien', () => {
        // Mieux vaut un message dans la mauvaise langue qu’un `undefined`
        // affiché à un client en train de payer.
        assert.equal(customerMessage('wrong_pin', 'is'), customerMessage('wrong_pin', 'fr'));
    });

    test('une langue peut être ajoutée — le portugais de Guinée-Bissau, le bambara', () => {
        const pt = Object.fromEntries(
            ERROR_CODES.map((c) => [c, `pt:${c.replace(/_/g, ' ')}`])
        ) as Record<ErrorCode, string>;

        registerCustomerMessages('pt', pt);
        assert.equal(customerMessage('insufficient_funds', 'pt'), 'pt:insufficient funds');
        assert.ok(availableLocales().includes('pt'));
    });
});

describe('PaymentError', () => {
    test('les drapeaux sont dérivés du code, pas déclarés à la main', () => {
        const e = new PaymentError({ code: 'network_timeout', provider: 'hub2' });
        assert.equal(e.retryable, false);
        assert.equal(e.needsReconciliation, true);
        assert.equal(e.name, 'PaymentError');
    });

    test('le message par défaut est celui du client', () => {
        assert.equal(new PaymentError({ code: 'wrong_pin' }).message, 'Code secret incorrect.');
    });

    test('customerMessage() accepte une langue', () => {
        const e = new PaymentError({ code: 'wrong_pin', message: 'ERR_PIN_4411' });
        assert.equal(e.message, 'ERR_PIN_4411', 'le message technique reste disponible');
        assert.equal(e.customerMessage('en'), 'Incorrect PIN.');
    });

    test('retryAfterMs est transporté jusqu’au planificateur', () => {
        const e = new PaymentError({ code: 'rate_limited', retryAfterMs: 3_000 });
        assert.equal(e.retryAfterMs, 3_000);
        assert.equal(e.toJSON().retryAfterMs, 3_000);
    });

    test('toJSON ne divulgue RIEN du fournisseur au-delà de son code', () => {
        const e = new PaymentError({
            code: 'provider_error',
            provider: 'hub2',
            providerCode: 'internal_error',
            cause: { apiKey: 'sk_live_secret', body: 'réponse brute entière' },
        });

        const json = JSON.stringify(e.toJSON());
        assert.ok(!json.includes('sk_live_secret'));
        assert.ok(!json.includes('réponse brute'));
        assert.ok(json.includes('internal_error'), 'le code brut reste utile au support');
    });

    test('la cause est conservée pour le débogage, sans être sérialisée', () => {
        const cause = new Error('socket fermée');
        const e = new PaymentError({ code: 'provider_unavailable', cause });
        assert.equal(e.cause, cause);
        assert.equal((e.toJSON() as Record<string, unknown>)['cause'], undefined);
    });
});
