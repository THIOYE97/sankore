# Contribuer à Sankoré

Les contributions sont bienvenues, en particulier pour **les corridors que nous
ne pratiquons pas directement**. Quelqu'un qui intègre Moov au Togo chaque jour
sait des choses qu'aucune documentation OpenAPI ne dit.

---

## En deux minutes

```bash
git clone https://github.com/THIOYE97/sankore.git
cd sankore
npm ci
npm run verify     # conventions, versions, types, tests, couverture
npm run demo       # les sept situations d'un paiement ouest-africain
```

**Node 22.6+** est requis pour développer : les sources s'exécutent directement
en TypeScript, sans étape de compilation. Le paquet *publié*, lui, tourne sur
Node 20+.

`npm run verify` est exactement ce que lance la CI. Si elle passe chez vous, elle
passera là-bas.

---

## Les règles qui ne se négocient pas

Ce ne sont pas des préférences de style. Chacune protège de l'argent, et une
pull request qui les enfreint sera refusée même si elle est par ailleurs
excellente.

### 1. On ne rejoue jamais ce dont on ignore le sort

`network_timeout` n'est **pas** rejouable. Un délai dépassé ne dit rien de ce qui
s'est passé en face : le virement a peut-être abouti. Le rejouer paie deux fois.

En conséquence :

- toute requête HTTP qui **crée un mouvement d'argent** porte `maxRetries: 0` ;
- les **lectures** sont rejouables normalement ;
- le verrou d'idempotence ne relâche sa clé que s'il est **certain** que rien
  n'a été engagé.

### 2. Jamais de flottant pour de l'argent

`0.1 + 0.2 !== 0.3`. Tout passe par `Money`, en unités mineures entières.

Et le piège régional : **XOF, XAF et GNF n'ont pas de subdivision**. `1500 XOF`
vaut 1500 unités mineures, pas 150 000. C'est l'erreur qui ne se voit qu'en
production, sur de vrais virements.

### 3. Aucune dépendance d'exécution

Node et rien d'autre. C'est vérifié en CI. Une bibliothèque de paiement qui
traîne un arbre de dépendances est refusée en revue de sécurité, à juste titre.

Les outils de **développement** sont une autre affaire : TypeScript est là, et
c'est tout ce dont nous avons besoin.

### 4. Aucun secret dans un journal

Rien ne part vers un `Observer` sans passer par `redact()`. Une clé d'API
recopiée dans un index de logs est une clé compromise : elle y survivra des
années, lisible par toute l'entreprise.

### 5. Le commentaire explique POURQUOI, jamais QUOI

```ts
// ✗ Incrémente le compteur d'échecs
this.failures += 1;

// ✓ `authentication_failed` est volontairement absent des signaux de santé :
//   des identifiants invalides font échouer chaque appel, le disjoncteur
//   s'ouvrirait aussitôt et masquerait la vraie cause derrière un
//   « service indisponible ».
```

Le code dit déjà ce qu'il fait. Ce qu'on ne peut pas relire dans six mois, c'est
la raison d'un choix — et dans ce domaine, presque chaque choix en a une qui a
coûté quelque chose à quelqu'un.

Chaque module du cœur s'ouvre sur un en-tête qui dit sa raison d'être. Le
contrôle des conventions le vérifie.

### 6. Les tests décrivent un comportement, pas une implémentation

Les noms sont des phrases en français :

```ts
test('un TIMEOUT ne déclenche JAMAIS de bascule — risque de double paiement', …)
test('un échec retardataire n’écrase JAMAIS un succès', …)
```

Jamais de réseau dans les tests : `fetchImpl`, `now`, `sleep` et `random` sont
injectables partout. Un test qui dort réellement est un test qu'on désactive six
mois plus tard parce que la CI est trop lente.

### 7. Ne testez pas sur les messages, testez sur les codes

Le texte d'un message destiné au client final peut changer dans une version
mineure. `ErrorCode`, lui, est stable — voir [VERSIONING.md](VERSIONING.md).

---

## Pourquoi il n'y a pas d'ESLint

La question est légitime en revue d'architecture. La réponse est assumée.

L'essentiel de ce qu'ESLint apporterait ici est déjà couvert par `tsc` en mode
strict : `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`. Ce
qui resterait, c'est une poignée de règles propres à **ce** projet, qu'aucune
configuration générique ne connaît :

- pas de `any` — dans du code qui manipule de l'argent, c'est une vérification
  perdue ;
- pas d'écriture directe dans les journaux — une bibliothèque émet des
  observations, l'hôte en décide ;
- pas de lecture de `process.env` — la configuration passe en argument, ce qui
  rend un adaptateur testable et multi-compte ;
- imports relatifs en `.ts` ;
- pas de `TODO`/`FIXME` dans du code publié ;
- en-tête de module obligatoire.

C'est [`scripts/lint.mjs`](scripts/lint.mjs) : cinquante lignes sans dépendance,
plutôt que trois cents paquets transitifs sur le chemin de la CI d'un paquet de
paiement. Si vous pensez qu'une règle manque, proposez-la — dans ce fichier.

---

## Écrire un adaptateur de fournisseur

C'est la contribution la plus utile. Un second agrégateur donnerait enfin au
repli du routeur un endroit où aller.

### La marche à suivre

1. **Ouvrez une issue d'abord** avec le gabarit « Nouvel adaptateur ». Nous vous
   dirons ce que nous savons déjà de ce fournisseur — et ce qu'il ne faut
   surtout pas croire de sa documentation.
2. `src/providers/<nom>.ts`, implémentant `PaymentProvider`.
3. Réutilisez `HttpClient`. Il porte le plus difficile : délais, reprises
   limitées aux erreurs sûres, en-tête d'idempotence, traduction des statuts.
4. **Traduisez toutes les causes d'échec** du fournisseur vers `ErrorCode`, et
   conservez le code brut dans `providerCode`. Une table partielle laisse des
   erreurs en `unknown`, et `unknown` déclenche une réconciliation — donc du
   travail humain, pour rien.
5. **Datez vos sources.** Nos adaptateurs portent en en-tête la date de
   vérification de la spécification, et l'URL :

   ```
   * Références (vérifiées le 5 août 2026) :
   *   - OpenAPI  https://api.hub2.io/docs-json  (v2.156.0)
   ```

   Les API de paiement ouest-africaines changent sans préavis et sans journal de
   versions. Savoir contre quoi un adaptateur a été écrit est la seule façon de
   diagnostiquer sa dérive.
6. **Dites ce que vous ne couvrez pas.** Notre adaptateur Hub2 refuse
   explicitement le virement bancaire et la carte, avec la raison. Un refus clair
   vaut infiniment mieux qu'une requête qui part incomplète.

### Ce qu'un adaptateur doit prouver par ses tests

Au-delà du chemin heureux, ces cas-là :

| | |
|---|---|
| **Rejeu de la même référence** | ne crée rien de neuf, rend l'état existant |
| **Délai dépassé** | lève `network_timeout`, et `fetchStatus` révèle la vérité |
| **Chaque cause d'échec** | est traduite, code brut conservé |
| **Webhook en désordre** | n'écrase pas un état final |
| **Webhook mal signé** | est refusé sans rien modifier |
| **Statut inconnu du fournisseur** | lève plutôt que de deviner |

L'adaptateur Hub2 est couvert par plus de 115 tests. C'est le niveau attendu —
pas par formalisme, mais parce que c'est ce qu'il faut pour oser l'exécuter en
production sur l'argent de quelqu'un d'autre.

---

## Pull requests

- **Une intention par PR.** Un correctif, ou un adaptateur, ou une
  réorganisation — pas les trois.
- **`npm run verify` doit passer**, couverture comprise. Les seuils sont fixés
  juste sous le niveau actuel : toute régression bloque.
- **Messages de commit en français, à l'impératif**, décrivant l'intention :

  ```
  Reprises HTTP réglables par requête
  L'encaissement impose un état de plus : action_required
  ```

  Pas `fix`, pas `wip`, pas `update code`.
- **Signalez toute rupture de comportement** dans la description. Si votre
  changement laisse le code des utilisateurs compiler mais agir autrement,
  c'est l'information la plus importante de votre PR.
- Mettez à jour le [CHANGELOG](CHANGELOG.md) sous `[Non publié]`.

---

## Licence des contributions

Sankoré est en **double licence** : AGPL-3.0 pour le logiciel libre, licence
commerciale pour l'usage propriétaire — voir le [README](README.md#licence).

En proposant une contribution, vous acceptez qu'elle soit distribuée sous **ces
deux licences**, y compris la commerciale. C'est ce qui permet au modèle de
tenir : sans cela, une seule contribution sous AGPL stricte rendrait impossible
la vente de licences qui finance la maintenance.

Vous conservez le droit d'auteur sur votre travail. Nous n'exigeons aucune
cession.

---

## Signaler une faille

**N'ouvrez pas d'issue publique.** Voir [SECURITY.md](SECURITY.md) —
`security@relayops.africa`.

---

## Conduite

Soyez utile, soyez précis, soyez courtois. Les désaccords techniques se
tranchent par des arguments et, si possible, par un test.

Nous ne tolérons ni harcèlement ni mépris. Un rapport :
`contact@relayops.africa`.

---

© 2026 RelayOps — Bamako, Mali.
