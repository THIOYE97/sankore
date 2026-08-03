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

## Démonstration

```bash
npm run demo
```

Déroule les sept situations réelles d'un paiement ouest-africain — dont le **délai dépassé**, celle que presque personne ne traite. Aucun identifiant, aucun réseau : le fournisseur simulateur (`SandboxProvider`) implémente réellement le contrat et conserve son état.

## Installation

```bash
npm install sankore
```

Node 22.6+ requis.

## Tests

```bash
npm test     # 56 tests, aucune dépendance
```

---

## Écrire son propre adaptateur

`HttpClient` fournit le plus difficile : délais d'attente, reprises à backoff exponentiel **limitées aux erreurs sûres**, en-tête d'idempotence, traduction des statuts HTTP. `verifyHmacSignature` vérifie les webhooks en temps constant.

Il ne reste que les particularités du fournisseur : URL, authentification, format du payload.

```ts
class MonOperateur implements PaymentProvider {
  readonly name = 'mon-operateur';
  private http = new HttpClient({ baseUrl: 'https://api.exemple.com' });

  capabilities() { return [{ rail: 'mobile_money', country: 'ML', currency: 'XOF', direction: 'payout' }]; }

  async execute(req) {
    const res = await this.http.request(
      { method: 'POST', path: '/payouts', body: { /* … */ }, idempotencyKey: req.reference },
      this.name
    );
    // traduire la réponse en PaymentResult
  }
  // fetchStatus, parseWebhook…
}
```

## État du projet

Le **cœur est stable et testé** : `Money`, machine à états, taxonomie d'erreurs, routeur, idempotence, mécanique HTTP et fournisseur simulateur.

Les adaptateurs vers les agrégateurs réels sont en cours.

Contributions bienvenues, en particulier pour les corridors que je ne pratique pas directement.

---

## Qui édite Sankoré

Sankoré est développé par **[RelayOps](https://relayops.africa)** — technologie des opérations en Afrique de l'Ouest, depuis Bamako, Mali.

Il est né de l'intégration de **six agrégateurs de paiement** sur des flux de transfert d'argent transfrontalier en production. Ce que vous lisez ici, ce sont les décisions qui ont survécu au terrain.

**Il est et restera libre.** Nous le maintenons parce qu'il sert notre propre travail.

Si vous préférez ne pas intégrer vous-même, nous proposons l'audit, l'intégration et la maintenance de flux de paiement ouest-africains : `thioyenouhoummariko@gmail.com`.

## Licence

MIT
