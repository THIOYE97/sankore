import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Money, MoneyError, currencyExponent } from '../src/core/money.ts';

describe('Money — franc CFA sans décimale', () => {
    test('XOF a zéro décimale : 1500 majeur = 1500 mineur', () => {
        assert.equal(Money.major(1500, 'XOF').amount, 1500);
        assert.equal(currencyExponent('XOF'), 0);
    });

    test('EUR a deux décimales : 15 majeur = 1500 mineur', () => {
        assert.equal(Money.major(15, 'EUR').amount, 1500);
    });

    test('le piège du facteur 100 : 1500 XOF ≠ 1500 EUR en unités mineures', () => {
        // Un SDK qui suppose 2 décimales partout multiplierait le XOF par 100.
        assert.equal(Money.major(1500, 'XOF').amount, 1500);
        assert.equal(Money.major(1500, 'EUR').amount, 150000);
    });

    test('refuse une précision impossible pour la devise', () => {
        assert.throws(() => Money.major(10.5, 'XOF'), MoneyError);
        assert.throws(() => Money.major(10.005, 'EUR'), MoneyError);
    });

    test('refuse un montant mineur non entier', () => {
        assert.throws(() => Money.minor(10.5, 'XOF'), MoneyError);
    });
});

describe('Money — arithmétique sans perte', () => {
    test('addition et soustraction', () => {
        const a = Money.minor(1000, 'XOF');
        const b = Money.minor(250, 'XOF');
        assert.equal(a.add(b).amount, 1250);
        assert.equal(a.subtract(b).amount, 750);
    });

    test('refuse de mélanger deux devises', () => {
        const xof = Money.minor(1000, 'XOF');
        const eur = Money.minor(1000, 'EUR');
        assert.throws(() => xof.add(eur), MoneyError);
    });

    test('le piège du flottant est évité', () => {
        // 0.1 + 0.2 !== 0.3 en JS. Avec des entiers, aucune dérive.
        const total = Money.minor(10, 'EUR').add(Money.minor(20, 'EUR'));
        assert.equal(total.amount, 30);
    });

    test('allocate ne perd JAMAIS une unité', () => {
        const parts = Money.minor(1000, 'XOF').allocate(3);
        assert.deepEqual(parts.map((p) => p.amount), [334, 333, 333]);
        const somme = parts.reduce((acc, p) => acc.add(p), Money.zero('XOF'));
        assert.equal(somme.amount, 1000);
    });

    test('allocate sur un montant indivisible reste exact', () => {
        for (const montant of [1, 7, 99, 100001]) {
            const parts = Money.minor(montant, 'XOF').allocate(7);
            const somme = parts.reduce((a, p) => a.add(p), Money.zero('XOF'));
            assert.equal(somme.amount, montant, `perte sur ${montant}`);
        }
    });

    test('multiplication avec arrondi explicite (frais de 1,5 %)', () => {
        const m = Money.minor(1000, 'XOF');
        assert.equal(m.multiply(0.015).amount, 15);
        assert.equal(m.multiply(0.0154, 'floor').amount, 15);
        assert.equal(m.multiply(0.0154, 'ceil').amount, 16);
    });
});

describe('Money — sérialisation', () => {
    test('aller-retour JSON sans perte', () => {
        const m = Money.minor(123456, 'XOF');
        const back = Money.fromJSON(JSON.parse(JSON.stringify(m)));
        assert.ok(m.equals(back));
    });

    test('comparaisons', () => {
        const a = Money.minor(100, 'XOF');
        const b = Money.minor(200, 'XOF');
        assert.ok(b.greaterThan(a));
        assert.ok(a.lessThan(b));
        assert.ok(Money.zero('XOF').isZero());
    });
});
