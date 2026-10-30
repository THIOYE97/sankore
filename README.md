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
| **Prêt pour la production** | observabilité, disjoncteur, limiteur de débit, anti-rejeu des webhooks, réconciliation outillée |
| **Zéro dépendance** | Node 20+ et rien d'autre |

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

**Node 20+.** Le paquet publié est du JavaScript ESM avec ses déclarations de types — aucun drapeau, aucune dépendance d'exécution.

Le *développement* de Sankoré demande Node 22.6+ : les sources tournent directement en TypeScript, sans étape de compilation.

## Tests

```bash
npm test             # 307 tests, aucune dépendance
npm run verify       # ce que lance la CI : conventions, types, tests, couverture
```

## Documentation

| | |
|---|---|
| [En production](#en-production) | branchement complet, webhooks, réconciliation, tables, catalogue des erreurs, liste de contrôle avant mise en service |
| [SECURITY.md](SECURITY.md) | signalement d'une faille, délais engagés, **frontière de responsabilité** — ce que Sankoré garantit et ce qui reste à votre charge |
| [VERSIONING.md](VERSIONING.md) | ce qui constitue une rupture, politique de prise en charge, dépréciation, socle Node |
| [CHANGELOG.md](CHANGELOG.md) | journal des modifications, **ruptures de comportement en premier** |
| [CONTRIBUTING.md](CONTRIBUTING.md) | les règles qui ne se négocient pas, et comment écrire un adaptateur |

---

## En production

Le cœur empêche les fautes de paiement. Cette section porte le reste : ce qu'une
DSI exige avant d'autoriser une dépendance qui déplace de l'argent.

### Le branchement complet

```ts
import {
  Router, Hub2Provider, RateLimiter, SqlIdempotencyStore,
  jsonObserver, redact, Money,
} from 'sankore';

// 1. Observabilité. Un `Observer` est une simple fonction : elle se branche sur
//    pino, winston, OpenTelemetry ou console.log sans que Sankoré connaisse
//    aucun de ces outils.
const observer = jsonObserver((ligne) => logger.info(JSON.parse(ligne)));

// 2. Cadence. Les limites des agrégateurs ouest-africains sont basses, et les
//    dépasser ne coûte pas qu'un 429 : certains suspendent la clé d'API.
//    UN limiteur par fournisseur et par processus — pas un par client HTTP.
const limiter = new RateLimiter({ ratePerSecond: 5, burst: 10, observer });

// 3. Verrou d'idempotence PARTAGÉ. `MemoryIdempotencyStore` ne protège qu'un
//    seul processus : derrière un répartiteur de charge, il ne protège rien.
const store = new SqlIdempotencyStore({
  run: async (sql, params) => {
    const r = await pool.query(sql, params as unknown[]);
    return { rows: r.rows, affected: r.rowCount ?? 0 };
  },
});

const hub2 = new Hub2Provider({
  apiKey: config.hub2.apiKey,
  merchantId: config.hub2.merchantId,
  environment: 'live',
  limiter,
  observer,
});

const router = new Router([hub2], {
  idempotency: { store },   // execute() devient idempotent, sans y penser
  breaker: true,            // un fournisseur en panne est écarté sans appel réseau
  observer,
});
```

À partir de là, `router.execute()` porte les garanties. Elles ne dépendent plus
de la vigilance de l'appelant — **une garantie qu'il faut penser à activer n'est
pas une garantie.**

### Les trois choses que votre application doit persister

Sankoré ne tient aucune base de données. Trois informations doivent survivre à un
redémarrage, et l'oubli de la troisième est l'erreur la plus courante :

| | Pourquoi |
|---|---|
| `reference` | votre clé de l'opération, et la clé d'idempotence |
| `status` | l'état courant, que `WebhookInbox` compare à ce qui arrive |
| **`provider`** | **le nom du fournisseur retenu, enregistré AU MOMENT du routage** |

Le troisième se devine mal après coup. Pour réconcilier, il faut interroger le
fournisseur qui a (peut-être) reçu l'opération : en interroger un autre renvoie
« inconnu », ce qui serait lu comme « rien n'est parti » et autoriserait un
rejeu. Donc un double paiement, par déduction fausse.

### Multi-locataires

Deux clients peuvent légitimement employer la référence `CMD-1`. Sans préfixe, le
second recevrait le résultat du premier — un paiement attribué au mauvais compte,
ce qui est pire qu'un doublon :

```ts
const router = new Router([hub2], {
  idempotency: {
    store,
    keyFor: (req) => `${req.metadata!.tenant}:${req.reference}`,
  },
});
```

---

### Recevoir les webhooks

Le chemin sortant est facile. Le chemin **entrant** est celui qui fait mentir la
comptabilité : tout agrégateur réémet jusqu'à recevoir un 2xx, les événements
arrivent en désordre, et un `failed` retardataire appliqué sans garde-fou
transforme un encaissement réussi en échec dans les livres.

`WebhookInbox` enchaîne les quatre protections dans le bon ordre — signature,
doublon, ordre, transition — et vous rend **le code HTTP à répondre** :

```ts
import express from 'express';
import { WebhookInbox, SqlWebhookLog } from 'sankore';

const inbox = new WebhookInbox({
  provider: hub2,
  log: new SqlWebhookLog({ run }),       // anti-rejeu partagé entre processus
  load: async (ref) => (await db.paiement(ref))?.status ?? null,

  // Appelé UNIQUEMENT quand la transition est applicable : jamais sur un
  // doublon, jamais sur un webhook en désordre. C'est ici, et nulle part
  // ailleurs, que vos effets de bord partent.
  save: async (event, from, to) => {
    await db.majStatut(event.reference, to);
    if (to === 'succeeded') await libererCommande(event.reference);
  },
  observer,
});

// `express.raw()` et NON `express.json()` : une signature se calcule sur des
// octets, et `JSON.stringify(JSON.parse(x)) !== x` — l'ordre des clés n'est pas
// restitué. Reparser avant de vérifier invalide la signature.
app.post('/webhooks/hub2', express.raw({ type: '*/*' }), async (req, res) => {
  const decision = await inbox.handle(
    req.body.toString('utf8'),
    req.headers as Record<string, string>,
  );
  res.sendStatus(decision.httpStatus);
});
```

Les cinq décisions possibles :

| `decision` | HTTP | Ce qui s'est passé |
|---|---|---|
| `rejected` | **401** | signature invalide ou charge illisible — **rien n'a été modifié** |
| `replayed` | 200 | déjà traité. Le 2xx fait cesser la réémission |
| `ignored` | 200 | transition non applicable : désordre, ou état final déjà atteint |
| `unknown_reference` | 200 | référence inconnue de l'application — insister n'y changera rien |
| `applied` | 200 | transition appliquée, `save()` a été appelé |

Répondre autre chose que 2xx à un doublon relance la réémission à l'infini. Un
200 sur une signature invalide confirme à un attaquant que son envoi est passé.
C'est pour cela que le code est porté par la décision plutôt que laissé à
l'appelant.

> **À surveiller en priorité.** Une observation `webhook.ignored` portant
> `detail.finalStateContradicted: true` signifie que le fournisseur contredit vos
> livres. Sankoré protège l'état enregistré ; il ne peut pas vous dire lequel des
> deux a raison. Mettez une alerte dessus.

---

### Réconcilier

Toute la bibliothèque repose sur un refus : on ne rejoue jamais une opération
dont on ignore le sort. Ce refus laisse donc, par construction, un reste à
traiter — des références en suspens dont il faut aller chercher la vérité.

Sans outil, ce reste finit en requête SQL écrite à la main un vendredi soir, ou
en rien du tout. C'est ce « rien du tout » qui produit les écarts de caisse
qu'on ne sait plus expliquer six mois plus tard.

```ts
import { Reconciler } from 'sankore';

const reconciler = new Reconciler({
  providers: router,      // un Router convient tel quel
  store,                  // pour clore le dossier quand l'incertitude est levée
  concurrency: 4,         // borné : les limites de débit sont basses
  observer,
});

// Worker périodique — toutes les cinq minutes suffisent.
const enAttente = await store.pendingReconciliation(100);
const taches = await Promise.all(
  enAttente.map(async (rec) => ({
    reference: rec.key,
    provider: await db.fournisseurDe(rec.key),   // persisté au routage
    key: rec.key,
  })),
);

const issues = await reconciler.run(taches);
logger.info(Reconciler.summarize(issues));
```

**Le réconciliateur ne paie jamais.** Il n'appelle que `fetchStatus()`, une
lecture — la seule opération qu'on peut se permettre de rejouer autant de fois
qu'il le faut.

| `outcome` | Ce que ça veut dire | Suite |
|---|---|---|
| `resolved` | état final constaté | la clé passe en `completed`, l'incertitude est levée |
| `pending` | toujours en cours chez le fournisseur | on repassera, rien ne change |
| `never_sent` | le fournisseur ne connaît pas la référence | **rien n'est parti** : la clé est relâchée, un rejeu devient légitime |
| `unreachable` | impossible d'interroger | l'incertitude demeure. Alerter si cela dure |
| `unknown_provider` | fournisseur absent du registre | erreur de configuration, à corriger tout de suite |

`never_sent` est le cas le plus utile : c'est le **seul** chemin par lequel
rejouer après un timeout devient sûr — parce qu'on a vérifié, au lieu de
supposer.

> Une entrée qui stagne en `needs_reconciliation` est de l'argent dont personne
> ne sait s'il est parti. `store.pendingReconciliation()` est la requête à
> brancher sur une alerte, et `purge()` n'y touche jamais : oublier une
> incertitude sur un mouvement d'argent est interdit par construction.

---

### Les tables

Deux tables, et dans les deux cas **l'unicité est portée par la base, pas par du
code**. Un `SELECT` suivi d'un `INSERT` laisse passer deux appels concurrents —
précisément le cas que le verrou existe pour fermer.

```sql
CREATE TABLE sankore_idempotency (
  key         TEXT PRIMARY KEY,
  state       TEXT NOT NULL CHECK (state IN ('in_flight','completed','needs_reconciliation')),
  result      JSONB,
  error       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON sankore_idempotency (state, created_at);

CREATE TABLE sankore_webhook_log (
  event_id    TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON sankore_webhook_log (received_at);
```

Aucun pilote n'est imposé : vous fournissez un `SqlRunner` de trois lignes contre
celui que vous avez déjà. MySQL et SQLite sont pris en charge via
`placeholder: MYSQL_PLACEHOLDER`.

---

### Observabilité

Une intégration de paiement qui ne se raconte pas est indéfendable : quand un
client affirme avoir payé, il faut pouvoir prouver ce qui est parti, quand, vers
qui, et ce qui est revenu.

Trente types d'événements, en cinq familles : `http.*`, `payment.*`, `breaker.*`,
`webhook.*`, `reconcile.*`.

```ts
const observer = (o: Observation) => {
  metrics.increment(o.kind, { provider: o.provider ?? 'n/a' });
  if (o.durationMs) metrics.timing(`${o.kind}.duree`, o.durationMs);
  logger.info(o);
};
```

Un `Observer` qui lève est neutralisé : perdre une ligne de journal est
désagréable, perdre un virement ne l'est pas.

**Rien ne sort en clair.** `redact()` supprime les secrets et masque les données
personnelles :

```ts
redact({ ApiKey: 'sk_live_xxx', msisdn: '+22370123456', holderName: 'Awa Traoré' });
// { ApiKey: '[secret]', msisdn: '223…3456', holderName: 'A. T.' }
```

La différence entre les deux traitements est volontaire. Un secret n'a aucune
raison d'être lisible — il est **supprimé**, jamais tronqué, parce que la moitié
d'une clé d'API reste une information qu'on n'a pas à donner. Un numéro de
téléphone, lui, est **masqué** : le support doit garder de quoi rapprocher une
réclamation d'une trace, sans que l'annuaire de la clientèle finisse dans un
index de logs.

`scrubPath()` retire la chaîne de requête avant toute observation : une
référence métier n'a rien à faire dans un journal d'accès, qui est souvent le
moins protégé de la chaîne.

### Sonde de santé

```ts
app.get('/health', (_req, res) => {
  const fournisseurs = router.health();
  const degrade = fournisseurs.some((f) => f.state !== 'closed');
  res.status(degrade ? 503 : 200).json({ fournisseurs });
});
```

Un fournisseur en panne est **relégué**, pas retiré : si tous sont tombés, mieux
vaut tenter le moins mal portant que répondre « corridor non couvert » — une
réponse qui enverrait l'exploitation chercher un problème de configuration
inexistant.

Le disjoncteur ne compte que les **signaux de santé**. Un solde insuffisant est
une réponse parfaitement saine : dix clients à découvert ne doivent pas écarter
un agrégateur en pleine forme. Des identifiants invalides non plus — l'erreur de
configuration doit rester bruyante jusqu'à sa correction, pas se cacher derrière
un « service indisponible ».

---

### Catalogue des erreurs

Le tableau de référence pour écrire votre `switch`. **Deux colonnes décident de
tout** : rejouer une erreur non rejouable, c'est payer deux fois.

| `code` | Rejouable | À réconcilier | Conduite à tenir |
|---|:---:|:---:|---|
| `insufficient_funds` | — | — | afficher `customerMessage()` |
| `invalid_account` | — | — | afficher ; faire corriger le numéro |
| `account_limit_exceeded` | — | — | afficher ; plafond opérateur ou réglementaire |
| `account_blocked` | — | — | afficher ; renvoyer vers l'opérateur |
| `wrong_pin` | — | — | afficher ; permettre une nouvelle saisie |
| `customer_declined` | — | — | afficher ; le client a refusé ou laissé expirer |
| `invalid_request` | — | — | **bogue d'intégration** — journaliser, alerter |
| `authentication_failed` | — | — | **configuration** — alerter l'astreinte, ne pas réessayer |
| `unsupported_corridor` | — | — | routage : aucun fournisseur. Ne jamais réessayer |
| `duplicate_request` | — | — | l'opération existe déjà : l'interroger, ne pas la recréer |
| `not_found` | — | — | **verdict** : rien n'est parti chez le fournisseur |
| `provider_unavailable` | **oui** | — | rejouer avec backoff — rien n'a été engagé |
| `rate_limited` | **oui** | — | rejouer après `retryAfterMs`, jamais avant |
| `network_timeout` | **non** | **oui** | ⚠ **NE PAS REJOUER.** `fetchStatus()` d'abord |
| `provider_error` | — | **oui** | réconcilier : le fournisseur n'a pas su qualifier |
| `unknown` | — | **oui** | réconcilier ; signaler pour qu'on enrichisse la table |

```ts
try {
  const res = await router.execute(req);
  // …
} catch (err) {
  if (err instanceof ReconciliationRequiredError) {
    // Un appel précédent s'est terminé dans l'incertitude. Le rejeu est refusé
    // jusqu'à ce que le réconciliateur ait tranché. C'est voulu.
    return repondreEnAttente();
  }
  if (err instanceof PaymentError) {
    if (err.needsReconciliation) return await mettreEnFileDeReconciliation(req);
    if (err.retryable) return await rejouerPlusTard(req, err.retryAfterMs);
    return afficher(err.customerMessage(langueDuClient));   // 'fr' | 'en' | la vôtre
  }
  throw err;
}
```

Le catalogue de messages couvre le **français** et l'**anglais** — les corridors
servis incluent le Nigeria et le Ghana. `registerCustomerMessages()` accepte
toute autre langue : portugais de Guinée-Bissau, bambara, wolof.

`ErrorCode` est une union **ouverte** : un nouveau code peut apparaître dans une
version mineure. Prévoyez un `default`, et ne testez jamais sur le texte d'un
message — seulement sur les codes. Voir [VERSIONING.md](VERSIONING.md).

---

### Avant la première mise en production

- [ ] un **store d'idempotence partagé** (`SqlIdempotencyStore`), pas la version
      mémoire — derrière un répartiteur de charge elle ne protège rien
- [ ] `provider` persisté **au moment du routage**, pas déduit après coup
- [ ] `verifyWebhook` fourni pour Hub2 — sans lui, `parseWebhook` normalise
      **sans authentifier** (Hub2 ne publie pas son algorithme : demandez au
      support)
- [ ] la route de webhook lit le **corps brut**, pas un JSON reparsé
- [ ] un **journal anti-rejeu partagé** (`SqlWebhookLog`)
- [ ] le worker de réconciliation tourne, et son décompte est suivi
- [ ] une **alerte** sur `pendingReconciliation()` qui ne se vide pas
- [ ] une **alerte** sur `webhook.ignored` avec `finalStateContradicted: true`
- [ ] un `Observer` branché, et les données sensibles passées par `redact()`
- [ ] un **limiteur de débit par fournisseur**, partagé à l'échelle du processus
- [ ] `environment: 'live'` posé **explicitement** — le défaut est `sandbox`, et
      c'est voulu
- [ ] les secrets injectés par configuration : Sankoré ne lit jamais
      `process.env`
- [ ] votre `save()` de webhook **tolère d'être rejoué**, même si nous faisons
      tout pour que cela n'arrive pas

Pour les engagements de notre côté — délais de correctif, frontière de
responsabilité, politique de versions — voir [SECURITY.md](SECURITY.md) et
[VERSIONING.md](VERSIONING.md).

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

`HttpClient` fournit le plus difficile : délais d'attente, reprises à backoff exponentiel **avec jitter et limitées aux erreurs sûres**, `Retry-After` honoré, annulation par `AbortSignal`, limiteur de débit, en-tête d'idempotence, traduction des statuts HTTP, observations émises. `verifyHmacSignature` vérifie les webhooks en temps constant.

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

Les quatre règles à tenir, quel que soit le fournisseur :

| | |
|---|---|
| **Jamais de rejeu sur une création** | `maxRetries: 0` sur tout `POST` qui engage un mouvement d'argent. Un 502 ne prouve pas que rien n'est parti. Les lectures, elles, sont rejouables. |
| **`fetchStatus` prend VOTRE référence** | C'est la porte de sortie après un timeout — précisément le moment où l'identifiant du fournisseur n'a pas pu être mémorisé. Sans cela, pas de réconciliation. |
| **Traduire TOUTES les causes d'échec** | Code brut conservé dans `providerCode`. Une table partielle laisse des erreurs en `unknown`, et `unknown` déclenche une réconciliation — du travail humain, pour rien. |
| **`not_found` sur une référence inconnue** | C'est un **verdict** : il affirme que rien n'est parti. Le `Reconciler` s'appuie dessus pour relâcher un verrou en sûreté. Ne le confondez pas avec `invalid_request`. |

Le détail de ce qu'un adaptateur doit prouver par ses tests est dans
[CONTRIBUTING.md](CONTRIBUTING.md#écrire-un-adaptateur-de-fournisseur).

## État du projet

Le **cœur est stable et testé** : `Money`, machine à états, taxonomie d'erreurs, routeur, idempotence, mécanique HTTP et fournisseur simulateur.

La **couche d'exploitation est en place** : observabilité, disjoncteur, limiteur de débit, réception des webhooks, réconciliation, verrous d'idempotence partagés. Voir [En production](#en-production).

**Hub2** est le premier adaptateur réel — décaissement *et* encaissement sur 13 pays, écrit contre la spécification OpenAPI publiée et couvert par 115 tests.

**307 tests**, 97,9 % des lignes couvertes, types en mode strict. La CI vérifie à chaque commit que le paquet publié s'installe et fonctionne dans un projet tiers vierge, et qu'il n'embarque aucune dépendance d'exécution.

Suit : un second agrégateur, pour que le repli du routeur ait quelque part où aller. C'est la condition de la `1.0.0` — voir [VERSIONING.md](VERSIONING.md).

Contributions bienvenues, en particulier pour les corridors que je ne pratique pas directement.

---

## Qui édite Sankoré

Sankoré est développé par **[RelayOps](https://relayops.africa)** — technologie des opérations en Afrique de l'Ouest, depuis Bamako, Mali.

Il est né de l'intégration de **six agrégateurs de paiement** sur des flux de transfert d'argent transfrontalier en production. Ce que vous lisez ici, ce sont les décisions qui ont survécu au terrain.

**Il restera lisible, auditable et gratuit pour le logiciel libre.** Nous le maintenons parce qu'il sert notre propre travail.

Si vous préférez ne pas intégrer vous-même, nous proposons l'audit, l'intégration et la maintenance de flux de paiement ouest-africains : `contact@relayops.africa`.

---

## Licence

Sankoré est publié en **double licence**.

### GNU AGPL v3 — pour lire, étudier, contribuer, et pour le logiciel libre

Le texte complet est dans [LICENSE](LICENSE). Concrètement :

| Vous voulez… | AGPL |
|---|---|
| Lire le code, l'auditer, l'étudier avant de nous parler | ✅ sans aucune condition |
| L'utiliser dans un projet lui-même sous AGPL | ✅ |
| Le modifier, le republier sous AGPL | ✅ |
| L'intégrer dans un produit propriétaire | ❌ licence commerciale requise |
| L'intégrer dans un service en ligne fermé | ❌ licence commerciale requise |

⚠️ **La clause réseau de l'AGPL est le point important.** Contrairement à la GPL, faire tourner Sankoré derrière une API — sans jamais distribuer de binaire — déclenche l'obligation de publier le code source de l'ensemble du service sous AGPL. C'est le cas d'usage normal d'une bibliothèque de paiement : lisez-la avant de choisir.

### Licence commerciale — pour tout le reste

Un produit fermé, un SaaS propriétaire, une plateforme interne que vous ne voulez pas publier : `contact@relayops.africa`.

Elle est délibérément simple à obtenir. Nous préférons de loin une licence payée à une violation ignorée.

### Pourquoi pas MIT

Parce que lire et redistribuer ne sont pas la même chose.

Nous voulons que vous **lisiez** ce code — c'est tout l'intérêt de le publier, et c'est gratuit. Ce que nous ne souhaitons pas, c'est qu'un tiers l'intègre dans un produit fermé et le revende sans contrepartie. L'AGPL sépare exactement ces deux cas.

© 2026 RelayOps — Bamako, Mali.
