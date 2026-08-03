import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { transition, tryTransition, canTransition, isFinal, StatusTransitionError } from '../src/core/status.ts';

describe('Machine à états — le chemin normal', () => {
    test('pending -> processing -> succeeded', () => {
        let s = transition('pending', 'processing');
        s = transition(s, 'succeeded');
        assert.equal(s, 'succeeded');
    });

    test('un échec est possible depuis pending et processing', () => {
        assert.equal(transition('pending', 'failed'), 'failed');
        assert.equal(transition('processing', 'failed'), 'failed');
    });
});

describe('Machine à états — les protections', () => {
    test("un paiement réussi ne peut PAS devenir échoué", () => {
        // Le webhook retardataire qui ferait mentir la comptabilité.
        assert.throws(() => transition('succeeded', 'failed'), StatusTransitionError);
        assert.equal(canTransition('succeeded', 'failed'), false);
    });

    test('un succès ne peut être que reversé', () => {
        assert.equal(transition('succeeded', 'reversed'), 'reversed');
    });

    test('les états finaux sont vraiment terminaux', () => {
        for (const s of ['failed', 'reversed', 'expired'] as const) {
            assert.ok(isFinal(s));
            assert.throws(() => transition(s, 'processing'), StatusTransitionError);
        }
    });

    test('on ne revient jamais en arrière', () => {
        assert.throws(() => transition('processing', 'pending'), StatusTransitionError);
    });
});

describe('Machine à états — webhooks en désordre', () => {
    test('rejouer le même état est idempotent, pas une erreur', () => {
        assert.equal(transition('succeeded', 'succeeded'), 'succeeded');
        const r = tryTransition('succeeded', 'succeeded');
        assert.equal(r.applied, false);
        assert.equal(r.status, 'succeeded');
    });

    test('tryTransition ignore un webhook retardataire et explique pourquoi', () => {
        const r = tryTransition('succeeded', 'failed');
        assert.equal(r.applied, false);
        assert.equal(r.status, 'succeeded', 'le succès doit être préservé');
        assert.match(r.reason ?? '', /final/);
    });

    test('tryTransition applique une transition légitime', () => {
        const r = tryTransition('processing', 'succeeded');
        assert.equal(r.applied, true);
        assert.equal(r.status, 'succeeded');
    });
});
