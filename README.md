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
| **Les deux sens** | décaisser *et* encaisser — avec l'état `action_required` que l'encaissement impose |
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
import { Router, Money, Hub2Provider } from 'sankore';

const hub2 = new Hub2Provider({
  apiKey: process.env.HUB2_API_KEY!,
  merchantId: process.env.HUB2_MERCHANT_ID!,
  environment: 'live',
});

const router = new Router([hub2]);

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
npm test     # 171 tests, aucune dépendance
```

---

## Adaptateurs

### Hub2 — décaissement et encaissement

Couvre **13 pays** d'Afrique de l'Ouest et centrale en mobile money : Bénin, Burkina, Cameroun, Centrafrique, Congo, Côte d'Ivoire, Gabon, Guinée, Guinée équatoriale, Mali, Sénégal, Tchad, Togo — en XOF, XAF et GNF.

```ts
const hub2 = new Hub2Provider({
  apiKey: process.env.HUB2_API_KEY!,
  merchantId: process.env.HUB2_MERCHANT_ID!,
  // 'sandbox' par défaut : le mode réel est toujours un choix explicite.
  environment: 'live',
});

await hub2.execute({
  reference: 'PAY-2026-00042',
  direction: 'payout',
  amount: Money.major(25_000, 'XOF'),
  account: {
    rail: 'mobile_money',
    country: 'ML',
    identifier: '22370000000',
    institution: 'orange',
    holderName: 'Awa Traoré',
  },
});
```

Trois décisions valent d'être connues :

| | |
|---|---|
| **Une création n'est jamais rejouée** | Un 503 sur un `POST /transfers` ne prouve pas que rien n'est parti. Les lectures, elles, sont rejouées normalement. |
| **Un 409 déclenche une vérification** | Au lieu de supposer un doublon, l'adaptateur va voir si le virement existe : si oui le rejeu est idempotent, sinon l'erreur est relayée telle quelle. |
| **`fetchStatus` prend TA référence** | Hub2 indexe par `tr_…`, mais accepte le filtre `?reference=`. Après un timeout — précisément quand on n'a pas pu mémoriser son identifiant — la réconciliation reste possible. |

Le `pending` de Hub2 signifie « accepté, en cours » : il devient `processing`, pas `pending`. Les 17 causes d'échec sont traduites, le code brut étant conservé dans `providerCode`.

Les corridors intégrés sont un instantané. Pour router sur la couverture réelle du jour :

```ts
const hub2 = new Hub2Provider({
  …,
  capabilities: await Hub2Provider.fetchCapabilities(),
});
```

#### Encaisser : `direction: 'payin'`

Décaisser est un ordre — on envoie, ça part. **Encaisser est une demande** : il faut qu'une personne, quelque part, compose un code sur son téléphone. Sankoré ne fait pas semblant du contraire.

```ts
const res = await hub2.execute({
  reference: 'ENC-2026-00042',
  direction: 'payin',
  amount: Money.major(15_000, 'XOF'),
  account: { rail: 'mobile_money', country: 'ML', identifier: '22370000000', institution: 'orange' },
});

if (res.status === 'action_required') {
  switch (res.action?.type) {
    case 'otp':
      // Le client reçoit un code, l'application le renvoie.
      afficher(res.action.message);
      await hub2.confirm('ENC-2026-00042', codeSaisiParLeClient);
      break;
    case 'ussd':
      // Le client compose la syntaxe indiquée. Rien à renvoyer : le webhook tranchera.
      afficher(res.action.message);
      break;
    case 'redirect':
      rediriger(res.action.url);
      break;
  }
}
```

**`action_required` est un état à part entière**, ni succès ni échec. Le confondre avec `processing` conduit à interroger en boucle un paiement qui n'avancera jamais tout seul, et à ne jamais dire au client ce qu'on attend de lui.

Le `message` vient de Hub2 et est écrit pour être montré tel quel : il porte la syntaxe USSD exacte, que personne ne peut deviner.

Sous le capot, `execute()` enchaîne la création de l'intention et la tentative de paiement — l'appelant fournit dès le départ le montant *et* le numéro du payeur, rien ne justifie de lui imposer deux appels.

**L'idempotence est active dès la première lecture.** Avant de créer quoi que ce soit, l'adaptateur cherche si la référence existe déjà : si une tentative est partie, il rend l'état courant sans rien relancer ; si l'intention existe sans tentative, il la réutilise. Sans cela, deux appels avec la même référence débiteraient le client deux fois.

**Abonne-toi aux webhooks `payment_intent.*`, pas `payment.*`.** Un objet `Payment` ne contient que `intentId`, jamais ta référence — impossible de le rattacher à une commande. Les événements d'intention couvrent tout le cycle et portent `purchaseReference`. Les `payment.*` sont ignorés.

La **carte bancaire** est hors périmètre : elle réclame des données de facturation que `Account` ne modélise pas.

**Webhooks.** Hub2 signe dans l'en-tête `X-Signature` mais ne publie ni l'algorithme ni l'encodage. Plutôt que d'inventer une vérification qui donnerait une fausse assurance, `Hub2Options.verifyWebhook` la délègue — fournis la fonction que le support t'aura indiquée. Passe-lui le **corps brut**, jamais un objet déjà parsé : une signature se calcule sur des octets, et `JSON.stringify` ne restitue pas l'ordre des clés.

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

**Hub2** est le premier adaptateur réel — décaissement *et* encaissement sur 13 pays, écrit contre la spécification OpenAPI publiée et couvert par 115 tests.

Suivent : un second agrégateur, pour que le repli du routeur ait quelque part où aller.

Contributions bienvenues, en particulier pour les corridors que je ne pratique pas directement.

---

## Qui édite Sankoré

Sankoré est développé par **[RelayOps](https://relayops.africa)** — technologie des opérations en Afrique de l'Ouest, depuis Bamako, Mali.

Il est né de l'intégration de **six agrégateurs de paiement** sur des flux de transfert d'argent transfrontalier en production. Ce que vous lisez ici, ce sont les décisions qui ont survécu au terrain.

**Il est et restera libre.** Nous le maintenons parce qu'il sert notre propre travail.

Si vous préférez ne pas intégrer vous-même, nous proposons l'audit, l'intégration et la maintenance de flux de paiement ouest-africains : `thioyenouhoummariko@gmail.com`.

## Licence

MIT
