/**
 * Money — montants monétaires en unités mineures entières.
 *
 * Règle absolue : JAMAIS de nombre flottant pour de l'argent.
 * `0.1 + 0.2 === 0.30000000000000004` en JavaScript. Sur un transfert
 * de 500 000 XOF répété 10 000 fois, ces miettes deviennent un écart
 * de caisse que personne ne sait expliquer.
 *
 * Piège spécifique à l'Afrique de l'Ouest : le franc CFA (XOF/XAF) est une
 * devise SANS SUBDIVISION. 1000 XOF, c'est 1000 unités mineures, pas 100 000.
 * Les SDK internationaux supposent presque tous 2 décimales et se trompent
 * d'un facteur 100 — une erreur qui ne se voit qu'en production.
 */

export type Currency =
    | 'XOF'  // franc CFA BCEAO — Mali, Sénégal, Côte d'Ivoire, Burkina, Niger, Togo, Bénin, Guinée-Bissau
    | 'XAF'  // franc CFA BEAC  — Cameroun, Gabon, Tchad, Congo, RCA, Guinée équatoriale
    | 'GNF'  // franc guinéen
    | 'NGN'  // naira nigérian
    | 'GHS'  // cedi ghanéen
    | 'EUR'
    | 'USD';

/** Nombre de décimales par devise (ISO 4217). */
const EXPONENT: Record<Currency, number> = {
    XOF: 0,  // ⚠ zéro décimale
    XAF: 0,  // ⚠ zéro décimale
    GNF: 0,  // ⚠ zéro décimale
    NGN: 2,
    GHS: 2,
    EUR: 2,
    USD: 2,
};

export class MoneyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MoneyError';
    }
}

export class Money {
    /** Montant en unités mineures. 1500 XOF -> 1500. 15,00 EUR -> 1500. */
    readonly amount: number;
    readonly currency: Currency;

    private constructor(amount: number, currency: Currency) {
        if (!Number.isInteger(amount)) {
            throw new MoneyError(
                `montant non entier (${amount}) : les unités mineures sont toujours entières`
            );
        }
        if (!Number.isSafeInteger(amount)) {
            throw new MoneyError(`montant hors des entiers sûrs : ${amount}`);
        }
        this.amount = amount;
        this.currency = currency;
    }

    /** Depuis des unités mineures (la voie sûre, à privilégier). */
    static minor(amount: number, currency: Currency): Money {
        return new Money(amount, currency);
    }

    /**
     * Depuis des unités majeures. `Money.major(1500, 'XOF')` -> 1500 unités
     * mineures (0 décimale) ; `Money.major(15, 'EUR')` -> 1500.
     * Refuse toute précision excédentaire au lieu de l'arrondir en silence.
     */
    static major(amount: number, currency: Currency): Money {
        const factor = 10 ** EXPONENT[currency];
        const minor = amount * factor;
        if (!Number.isInteger(Math.round(minor * 1e6) / 1e6)) {
            throw new MoneyError(
                `${amount} ${currency} a plus de décimales que la devise n'en autorise (${EXPONENT[currency]})`
            );
        }
        return new Money(Math.round(minor), currency);
    }

    static zero(currency: Currency): Money {
        return new Money(0, currency);
    }

    private sameCurrency(other: Money): void {
        if (other.currency !== this.currency) {
            throw new MoneyError(
                `devises incompatibles : ${this.currency} et ${other.currency} — convertis explicitement`
            );
        }
    }

    add(other: Money): Money {
        this.sameCurrency(other);
        return new Money(this.amount + other.amount, this.currency);
    }

    subtract(other: Money): Money {
        this.sameCurrency(other);
        return new Money(this.amount - other.amount, this.currency);
    }

    /** Multiplication par un scalaire (frais, taux). Arrondi explicite. */
    multiply(factor: number, rounding: 'round' | 'floor' | 'ceil' = 'round'): Money {
        const raw = this.amount * factor;
        const fn = rounding === 'floor' ? Math.floor : rounding === 'ceil' ? Math.ceil : Math.round;
        return new Money(fn(raw), this.currency);
    }

    /**
     * Répartit un montant en n parts SANS perdre la moindre unité.
     * Les unités restantes sont distribuées une par une sur les premières
     * parts : la somme des parts égale toujours le total d'origine.
     */
    allocate(parts: number): Money[] {
        if (!Number.isInteger(parts) || parts < 1) {
            throw new MoneyError(`nombre de parts invalide : ${parts}`);
        }
        const base = Math.floor(this.amount / parts);
        let remainder = this.amount - base * parts;
        const out: Money[] = [];
        for (let i = 0; i < parts; i++) {
            const extra = remainder > 0 ? 1 : 0;
            remainder -= extra;
            out.push(new Money(base + extra, this.currency));
        }
        return out;
    }

    isZero(): boolean { return this.amount === 0; }
    isPositive(): boolean { return this.amount > 0; }
    isNegative(): boolean { return this.amount < 0; }

    equals(other: Money): boolean {
        return this.amount === other.amount && this.currency === other.currency;
    }

    compare(other: Money): number {
        this.sameCurrency(other);
        return this.amount < other.amount ? -1 : this.amount > other.amount ? 1 : 0;
    }

    greaterThan(other: Money): boolean { return this.compare(other) > 0; }
    lessThan(other: Money): boolean { return this.compare(other) < 0; }

    /** Valeur en unités majeures — pour l'AFFICHAGE uniquement, jamais pour calculer. */
    toMajor(): number {
        return this.amount / 10 ** EXPONENT[this.currency];
    }

    format(locale = 'fr-FR'): string {
        return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: this.currency,
            minimumFractionDigits: EXPONENT[this.currency],
            maximumFractionDigits: EXPONENT[this.currency],
        }).format(this.toMajor());
    }

    /** Sérialisation sûre : on transporte toujours les unités mineures. */
    toJSON(): { amount: number; currency: Currency } {
        return { amount: this.amount, currency: this.currency };
    }

    static fromJSON(v: { amount: number; currency: Currency }): Money {
        return Money.minor(v.amount, v.currency);
    }

    toString(): string {
        return `${this.amount} ${this.currency}`;
    }
}

export function currencyExponent(currency: Currency): number {
    return EXPONENT[currency];
}
