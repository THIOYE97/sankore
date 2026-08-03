# Sankoré

**Boîte à outils de paiement pour l'Afrique de l'Ouest.** Mobile money, banque, microfinance, portefeuille et carte — sous un seul contrat, quel que soit l'agrégateur derrière.

> Sankoré, du nom de l'université de Tombouctou.

---

## Pourquoi

Intégrer les paiements en Afrique de l'Ouest, c'est réécrire chaque fois le même code : un client HTTP par agrégateur, un dialecte d'erreurs par fournisseur, une machine à états bricolée, et l'espoir qu'aucun webhook n'arrive dans le désordre.

Sankoré fixe ce socle une bonne fois :

| | |
|---|---|
| **Cinq rails** | mobile money · banque · **microfinance** · portefeuille · carte |
| **Routage par corridor** | pays × rail × devise × montant → le bon fournisseur |
| **Erreurs normalisées** | un vocabulaire unique, avec la distinction *rejouable* / *à réconcilier* |
| **Idempotence** | une référence ne part jamais deux fois |
| **Machine à états** | un paiement réussi ne peut pas « échouer » après coup |
| **Zéro dépendance** | Node 22+ et rien d'autre |

La **microfinance** est un rail de première classe. Aucun acteur international ne la couvre — c'est pourtant par là que passe une partie majeure des flux régionaux.

---

## Le franc CFA sans décimale

Le XOF, le XAF et le GNF sont des devises **sans subdivision**. `1500 XOF`, c'est 1500 unités mineures — pas 150 000.

La plupart des bibliothèques internationales supposent deux décimales partout et se trompent d'un facteur 100. L'erreur ne se voit qu'en production, sur de vrais virements.

```ts
Money.major(1500, 'XOF').amount  // 1500   ✅
Money.major(1500, 'EUR').amount  // 150000 ✅
```

Et jamais de flottant : `0.1 + 0.2 !== 0.3` en JavaScript. Sur des milliers de transferts, ces miettes deviennent un écart de caisse inexplicable.

---

## Exemple

```ts
import { Router, Money } from 'sankore';

const router = new Router([bizao, intouch], {
  preference: ['bizao', 'intouch'],
});

const result = await router.execute({
  reference: 'PAY-2026-00042',        // sert de clé d'idempotence
  direction: 'payout',
  amount: Money.major(25_000, 'XOF'),
  account: {
    rail: 'mobile_money',
    country: 'ML',
    identifier: '22370000000',
    institution: 'orange',
  },
});

console.log(result.status);           // 'succeeded' | 'processing' | 'failed'
```

### Erreurs : la distinction qui protège l'argent

```ts
try {
  await router.execute(req);
} catch (err) {
  if (err.retryable) {
    // Sûr : rien n'est parti en face
    await rejouer(req);
  } else if (err.needsReconciliation) {
    // Un timeout ne dit RIEN sur ce qui s'est passé.
    // On interroge le statut réel — on ne rejoue jamais à l'aveugle.
    const vrai = await provider.fetchStatus(req.reference);
  } else {
    afficher(err.customerMessage());  // message en français, sans jargon
  }
}
```

**`network_timeout` n'est délibérément pas rejouable.** C'est la règle qui évite le double paiement.

---

## Installation

```bash
npm install sankore
```

Node 22.6+ requis.

## Tests

```bash
npm test     # 34 tests, aucune dépendance
```

---

## État du projet

Le **cœur est stable et testé** : `Money`, la machine à états, la taxonomie d'erreurs, le routeur et l'idempotence.

Les adaptateurs fournisseurs sont en cours. Le contrat `PaymentProvider` est public et documenté : écrire le sien prend une heure.

Contributions bienvenues, en particulier pour les corridors que je ne pratique pas directement.

## Licence

MIT
