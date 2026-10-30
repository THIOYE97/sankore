# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Versionnage selon [VERSIONING.md](VERSIONING.md).

Les **ruptures de comportement** — le code compile encore mais agit
différemment — sont listées en premier et en toutes lettres. C'est la catégorie
la plus dangereuse d'un journal de modifications, et celle qu'on escamote le
plus volontiers.

---

## [Non publié]

Cette version rend Sankoré exploitable en production d'entreprise. Le cœur
métier ne change pas de nature ; ce qui change, c'est tout ce qu'une DSI exige
autour : traces, santé des fournisseurs, cadence, réception des webhooks,
réconciliation, verrous partagés — et un défaut d'idempotence qui pouvait
produire un double paiement.

### ⚠ Ruptures de comportement

- **`withIdempotency` ne libère plus la clé sur toute erreur.**
  Jusqu'ici, un échec quelconque relâchait le verrou. Avec un `network_timeout`,
  cela autorisait un rejeu — et le rejeu pouvait **payer une seconde fois**,
  précisément ce que la bibliothèque existe pour empêcher.

  Désormais la clé n'est relâchée que lorsqu'il est **certain** que rien n'a été
  engagé (`PaymentError` dont `needsReconciliation` est faux). Sinon elle passe
  dans le nouvel état `needs_reconciliation` et **reste prise**. Un rejeu lève
  `ReconciliationRequiredError`.

  *Migration* : traitez `ReconciliationRequiredError` en appelant
  `provider.fetchStatus(reference)`, puis `resolveReconciliation()` — ou
  branchez le `Reconciler`, qui fait les deux. Une exception inattendue (non
  `PaymentError`) est désormais aussi considérée comme incertaine : elle a pu
  survenir après que la requête HTTP a abouti.

- **`mapHttpStatus(404)` rend `not_found` et non plus `invalid_account`.**
  Un 404 signifie « cette ressource n'existe pas chez le fournisseur », ce qui
  arrive surtout en interrogeant une référence inconnue. L'ancien code affichait
  au client *« Ce numéro ne correspond à aucun compte actif »* pour une cause
  qui était souvent de notre côté. `410` est mappé de la même façon.

  *Migration* : si vous testiez `code === 'invalid_account'` pour détecter une
  opération introuvable, testez `'not_found'`.

- **`fetchStatus` et `confirm` lèvent `not_found` sur une référence inconnue**
  (Hub2 et `SandboxProvider`), au lieu de `invalid_request`. Ce n'est pas
  cosmétique : `not_found` est un **verdict** exploitable — le fournisseur
  affirme ne rien connaître de la référence, donc rien ne lui est parvenu. C'est
  sur ce code que le `Reconciler` s'appuie pour relâcher un verrou en sûreté.

- **Les reprises HTTP comportent désormais un jitter.** Le délai est tiré au
  hasard entre 0 et le plafond exponentiel, au lieu d'être exactement
  `base × 2^n`. Sans jitter, mille requêtes interrompues par la même panne
  repartent à la même milliseconde et achèvent le fournisseur au moment où il se
  relève. Si vos tests asseyaient sur des délais exacts, injectez `random`.

- **`exactOptionalPropertyTypes` est activé.** Conséquence pour les
  implémenteurs d'adaptateurs : poser explicitement `{ fee: undefined }` n'est
  plus accepté là où le champ est optionnel — il faut ne pas poser le champ.
  La nuance n'est pas académique sur `PaymentResult`, où `fee`, `error` et
  `action` sont porteurs de sens.

- **`IdempotencyStore` gagne une méthode : `markForReconciliation`.** Toute
  implémentation maison doit l'ajouter.

### Ajouté

**Observabilité** — `src/core/observability.ts`
- `Observer`, une simple fonction, branchable sur pino, winston, OpenTelemetry
  ou `console.log` sans que Sankoré connaisse aucun de ces outils.
- `Observation` : 30 types d'événements couvrant réseau, cycle de vie d'un
  paiement, santé des fournisseurs, webhooks et réconciliation.
- `redact()` : supprime les secrets (clés d'API, jetons, OTP, signatures),
  masque les données personnelles (`+22370123456` → `223…3456`), borne
  profondeur, longueur et taille des tableaux, détecte les cycles.
- `scrubPath()` : retire la chaîne de requête, pour qu'aucune référence métier
  ne finisse dans un journal d'accès.
- `safeObserver()` : un journal cassé ne casse jamais un paiement.
- `composeObservers()`, `jsonObserver()`.

**Santé des fournisseurs** — `src/core/breaker.ts`
- `CircuitBreaker` et `BreakerRegistry`. Un fournisseur qui enchaîne les pannes
  est écarté sans appel réseau. Seuls les **signaux de santé** comptent : un
  solde insuffisant est une réponse saine et n'ouvre rien ; des identifiants
  invalides non plus, pour que l'erreur de configuration reste bruyante.
- `Router.health()` pour alimenter une sonde `/health`.

**Cadence** — `src/core/limiter.ts`
- `RateLimiter` : seau à jetons servi en FIFO, avec plafond d'attente et
  annulation. Les limites des agrégateurs ouest-africains sont basses, et les
  dépasser suspend la clé d'API.

**Réception des webhooks** — `src/core/webhook.ts`
- `WebhookInbox` enchaîne les quatre protections dans le bon ordre : signature,
  doublon, ordre, transition — et rend le **code HTTP à répondre**. Répondre
  autre chose que 2xx à un doublon relance la réémission à l'infini.
- `MemoryWebhookLog`, `SqlWebhookLog` (anti-rejeu adossé à une contrainte
  d'unicité en base, donc atomique entre processus).
- `WebhookEvent` gagne `eventId` et `occurredAt`.

**Réconciliation** — `src/core/reconciler.ts`
- `Reconciler` : n'appelle **que** `fetchStatus()`, jamais `execute()`. Rend
  cinq issues distinctes, dont `never_sent` — le seul chemin par lequel rejouer
  après un timeout devient légitime, parce qu'on a vérifié au lieu de supposer.
- Parallélisme borné, `Reconciler.summarize()` pour les métriques.

**Verrous de production** — `src/core/idempotency.ts`, `src/core/sql.ts`
- `SqlIdempotencyStore` : l'atomicité vient de la clé primaire, pas du code.
  Aucune dépendance — l'hôte fournit un `SqlRunner` de trois lignes contre son
  propre pilote. PostgreSQL et MySQL/SQLite via `Placeholder`.
- `pendingReconciliation()` : la file de travail du réconciliateur, et la
  requête à brancher sur une alerte.
- `purge()` ne touche **jamais** aux clés `needs_reconciliation`.

**Garanties portées par le routeur** — `src/core/router.ts`
- `RouterOptions.idempotency` : `execute()` est idempotent sans que l'appelant
  y pense. `keyFor` permet de préfixer par locataire.
- `RouterOptions.breaker`, `RouterOptions.observer`.
- `Router.provider(name)` et `Router.all()`, nécessaires pour réconcilier depuis
  un autre processus.

**Client HTTP** — `src/core/http.ts`
- `AbortSignal` par requête. Annuler une écriture ne l'annule que chez nous :
  c'est traduit en `network_timeout`, donc en réconciliation.
- `Retry-After` honoré, dans ses deux formes (secondes et date HTTP) ;
  `PaymentError.retryAfterMs` le transporte jusqu'au planificateur.
- `timeoutMs` par requête, plafond d'attente, `User-Agent` identifiant la
  version, `random`/`sleep` injectables.

**Messages client**
- Catalogue **anglais** en plus du français — les corridors couverts incluent le
  Nigeria et le Ghana, dont les devises sont dans `Currency`.
- `registerCustomerMessages()` pour toute autre langue : portugais de
  Guinée-Bissau, bambara, wolof.
- Repli par étiquette : `fr-SN` → `fr` → français.
- `ERROR_CODES` exporté, pour générer un catalogue d'erreurs.

**Exploitation du projet**
- CI GitHub Actions : conventions, cohérence des versions, types, tests et
  **seuils de couverture**, démonstration exécutable, vérification du
  **zéro dépendance**, installation du paquet dans un projet tiers vierge,
  contrôle du contenu du paquet, `npm audit`, compatibilité Node 20.
- `npm run verify` — une seule commande, pour un contributeur comme pour la CI.
- `npm run lint` : contrôle des conventions du projet, sans dépendance.
- `npm run check:version` : bloque une publication où `package.json` et
  `src/core/version.ts` divergent.
- `SECURITY.md`, `VERSIONING.md`, `CONTRIBUTING.md`, `CODEOWNERS`, gabarits
  d'issues et de pull request.

### Corrigé

- **Double paiement possible après un timeout** — voir les ruptures ci-dessus.
  C'est le correctif le plus important de cette version.
- Un 404 n'accuse plus le numéro du client.
- La démonstration annonçait « MIT » ; le projet est en AGPL-3.0 ou licence
  commerciale.

### Modifié

- Couverture de tests : **307 tests** (contre 171), 97,9 % des lignes.
- `tsconfig.json` : `exactOptionalPropertyTypes: true`.

---

## [0.1.0] — 2026-08-05

Première publication.

### Ajouté

- `Money` : montants en unités mineures entières, jamais de flottant. Gestion
  correcte des devises **sans subdivision** (XOF, XAF, GNF) — là où les SDK
  internationaux se trompent d'un facteur 100.
- Machine à états : un paiement `succeeded` ne peut pas « échouer » après coup.
  `tryTransition` pour les webhooks arrivant en désordre.
- Taxonomie d'erreurs normalisée, avec la distinction
  **rejouable / à réconcilier**. `network_timeout` n'est pas rejouable.
- `Router` : routage par corridor (pays × rail × devise × montant), repli en
  cascade optionnel et limité aux erreurs strictement rejouables.
- Idempotence : `withIdempotency`, `MemoryIdempotencyStore`.
- `HttpClient` : délais, reprises à backoff exponentiel limitées aux erreurs
  sûres, reprises réglables **par requête**, `verifyHmacSignature` en temps
  constant.
- `SandboxProvider` : fournisseur complet et déterministe, sans réseau.
- **Hub2** : premier adaptateur réel, décaissement *et* encaissement, 13 pays,
  avec l'état `action_required` que l'encaissement impose.
- Double licence AGPL-3.0 / commerciale.

[Non publié]: https://github.com/THIOYE97/sankore/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/THIOYE97/sankore/releases/tag/v0.1.0
