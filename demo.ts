/**
 * Démonstration exécutable de Sankoré.
 *
 *   node --experimental-strip-types demo.ts
 *
 * Aucun identifiant, aucun réseau, aucune dépendance. Déroule les quatre
 * situations réelles d'un paiement en Afrique de l'Ouest — dont celle que
 * presque personne ne traite correctement : le délai dépassé.
 */

import { Router } from './src/core/router.ts';
import { Money } from './src/core/money.ts';
import { PaymentError } from './src/core/errors.ts';
import { withIdempotency, MemoryIdempotencyStore } from './src/core/idempotency.ts';
import { SandboxProvider } from './src/providers/sandbox.ts';
import type { PaymentRequest } from './src/core/provider.ts';

const c = {
    or: '\x1b[38;5;220m', vert: '\x1b[38;5;35m', rouge: '\x1b[38;5;203m',
    gris: '\x1b[38;5;244m', gras: '\x1b[1m', z: '\x1b[0m',
};

const titre = (n: number, t: string) =>
    console.log(`\n${c.or}${c.gras}${'─'.repeat(64)}\n  ${n}. ${t}\n${'─'.repeat(64)}${c.z}\n`);
const ok = (m: string) => console.log(`  ${c.vert}✓${c.z} ${m}`);
const ko = (m: string) => console.log(`  ${c.rouge}✗${c.z} ${m}`);
const info = (m: string) => console.log(`  ${c.gris}${m}${c.z}`);

// Un opérateur simulé, avec un comportement fixé par numéro.
const orange = new SandboxProvider({
    name: 'orange-ml',
    scenarios: {
        '22370000001': { kind: 'succeed' },
        '22370000002': { kind: 'fail', code: 'insufficient_funds' },
        '22370000003': { kind: 'timeout' },
        '22370000004': { kind: 'pending_then_succeed' },
    },
});

const router = new Router([orange]);
const store = new MemoryIdempotencyStore();

const paiement = (ref: string, numero: string, montant: number): PaymentRequest => ({
    reference: ref,
    direction: 'payout',
    amount: Money.major(montant, 'XOF'),
    account: { rail: 'mobile_money', country: 'ML', identifier: numero, institution: 'orange' },
    label: 'Démonstration Sankoré',
});

console.log(`\n${c.or}${c.gras}  SANKORÉ${c.z} ${c.gris}— paiement ouest-africain, démonstration${c.z}`);

// ── 1 ─────────────────────────────────────────────────────────────────────
titre(1, 'Le franc CFA n’a pas de décimale');

const m = Money.major(25_000, 'XOF');
ok(`25 000 XOF  →  ${m.amount} unités mineures   ${c.gras}(pas 2 500 000)${c.z}`);
ok(`affichage : ${m.format()}`);
info('Un SDK qui suppose 2 décimales partout se trompe ici d’un facteur 100.');
const parts = Money.minor(1000, 'XOF').allocate(3);
ok(`1000 XOF réparti en 3 → ${parts.map((p) => p.amount).join(' + ')} = ${parts.reduce((a, p) => a.add(p), Money.zero('XOF')).amount}`);
info('Aucune unité perdue, quel que soit le montant.');

// ── 2 ─────────────────────────────────────────────────────────────────────
titre(2, 'Un paiement qui réussit');

const r1 = await router.execute(paiement('PAY-001', '22370000001', 25_000));
ok(`statut         ${c.gras}${r1.status}${c.z}`);
ok(`réf. opérateur ${r1.providerReference}`);
ok(`frais          ${r1.fee?.format()}`);

// ── 3 ─────────────────────────────────────────────────────────────────────
titre(3, 'Un échec — message prêt pour l’utilisateur');

const r2 = await router.execute(paiement('PAY-002', '22370000002', 25_000));
ko(`statut  ${c.gras}${r2.status}${c.z}`);
ko(`code    ${r2.error?.code}`);
info(`à afficher au client : « ${r2.error?.customerMessage()} »`);
info(`rejouable : ${r2.error?.retryable}  →  inutile de réessayer, le solde est insuffisant`);

// ── 4 ─────────────────────────────────────────────────────────────────────
titre(4, 'Le délai dépassé — le cas que presque personne ne traite');

try {
    await router.execute(paiement('PAY-003', '22370000003', 25_000));
} catch (err) {
    if (!(err instanceof PaymentError)) throw err;
    ko(`code               ${err.code}`);
    info(`rejouable          ${err.retryable}   ${c.gras}← surtout pas${c.z}`);
    info(`à réconcilier      ${err.needsReconciliation}`);
    console.log();
    info('Un timeout ne dit RIEN sur ce qui s’est passé chez l’opérateur.');
    info('Rejouer, c’est risquer de payer deux fois. On interroge d’abord :');
    console.log();
    const vrai = await orange.fetchStatus('PAY-003');
    ok(`fetchStatus → ${c.gras}${vrai.status}${c.z}  — le paiement était bien parti !`);
    info('C’est exactement là que les intégrations naïves perdent de l’argent.');
}

// ── 5 ─────────────────────────────────────────────────────────────────────
titre(5, 'Webhook en désordre — la comptabilité est protégée');

const r4 = await router.execute(paiement('PAY-004', '22370000004', 50_000));
ok(`statut initial  ${r4.status}`);
const evt = orange.settle('PAY-004', 'succeeded');
ok(`webhook reçu    ${c.gras}${evt.status}${c.z}`);
try {
    orange.settle('PAY-004', 'failed');
    ko('un échec tardif a été accepté — ce serait un bug');
} catch {
    ok(`webhook « failed » retardataire ${c.gras}refusé${c.z} — le succès est préservé`);
}

// ── 6 ─────────────────────────────────────────────────────────────────────
titre(6, 'Idempotence — le client tape deux fois sur « Envoyer »');

let appels = 0;
const envoyer = () =>
    withIdempotency('PAY-005', { store }, async () => {
        appels++;
        return router.execute(paiement('PAY-005', '22370000001', 10_000));
    });

const a = await envoyer();
const b = await envoyer();
ok(`deux appels, ${c.gras}${appels}${c.z} exécution réelle`);
ok(`même réf. opérateur : ${a.providerReference === b.providerReference}`);
info('Un seul virement est parti. C’est la garantie qui protège la caisse.');

// ── 7 ─────────────────────────────────────────────────────────────────────
titre(7, 'Routage — et la microfinance en rail de première classe');

for (const q of [
    { rail: 'mobile_money', country: 'ML', label: 'mobile money Mali' },
    { rail: 'mfi', country: 'ML', label: 'microfinance Mali' },
    { rail: 'bank', country: 'ML', label: 'banque Mali' },
    { rail: 'mobile_money', country: 'GN', label: 'mobile money Guinée' },
] as const) {
    const p = router.resolve({ rail: q.rail, country: q.country, currency: 'XOF', direction: 'payout', amount: 50_000 });
    p ? ok(`${q.label.padEnd(24)} → ${p.name}`) : ko(`${q.label.padEnd(24)} → non couvert`);
}
info('Stripe, Paystack et Flutterwave ne couvrent pas le rail « mfi ».');

console.log(`\n${c.or}${'─'.repeat(64)}${c.z}`);
console.log(`  ${c.gras}github.com/THIOYE97/sankore${c.z}  ${c.gris}— AGPL-3.0 ou licence commerciale, zéro dépendance${c.z}\n`);
