# Versions, compatibilité, dépréciation

Ce document existe parce qu'une DSI ne peut pas inscrire une dépendance de
paiement dans son socle sans savoir ce qui cassera, quand, et avec combien de
préavis. Il engage RelayOps.

---

## Semver, avec une précision qui compte

Sankoré suit le [versionnage sémantique 2.0.0](https://semver.org/lang/fr/).

| Changement | Version |
|---|---|
| Correction qui ne modifie aucun comportement observable | **patch** — `0.1.0` → `0.1.1` |
| Ajout rétrocompatible : nouvelle option, nouvel adaptateur, nouveau code d'erreur | **mineure** — `0.1.0` → `0.2.0` |
| Rupture de l'API publique | **majeure** — `0.9.0` → `1.0.0` |

### Ce que nous considérons comme une rupture

Et pas seulement les signatures de fonctions — c'est là que les bibliothèques de
paiement trahissent leurs utilisateurs sans incrémenter de majeure :

- retirer ou renommer un export de `src/index.ts` ;
- retirer une valeur de `ErrorCode`, `PaymentStatus` ou `Rail` ;
- **changer la correspondance entre une cause d'échec d'un fournisseur et un
  `ErrorCode`** — votre `switch` se mettrait à router différemment sans que rien
  ne le signale ;
- **changer le caractère rejouable d'un `ErrorCode`** — c'est la garantie qui
  protège l'argent ;
- ajouter une transition autorisée dans la machine à états, ou en retirer une ;
- modifier la forme d'un enregistrement persisté (`IdempotencyRecord`,
  table SQL) sans chemin de migration.

### Ce qui n'en est pas une

- ajouter un `ErrorCode`, un `PaymentStatus` ou un `ObservationKind` — traitez
  ces unions comme ouvertes, avec un `default` dans vos `switch` ;
- ajouter un champ **optionnel** à `PaymentResult`, `WebhookEvent` ou
  `Observation` ;
- ajouter un adaptateur, un corridor, une langue de message client ;
- modifier le texte d'un message destiné au client final — **ne testez jamais
  sur ces chaînes**, testez sur les codes ;
- modifier le contenu de `raw`, qui est par contrat non interprété.

---

## Avant la 1.0.0

Nous sommes en `0.x`. Honnêtement : **une version mineure peut rompre**, et
c'est ce que `0.x` signifie en semver. En pratique nous nous y tenons :

- toute rupture est listée en tête du [CHANGELOG](CHANGELOG.md), avec la
  manœuvre de migration ;
- aucune rupture silencieuse — si votre code compile encore mais se comporte
  autrement, c'est signalé en **RUPTURE DE COMPORTEMENT**, la catégorie la plus
  dangereuse et la plus facile à passer sous silence.

Épinglez une version mineure exacte (`"sankore": "0.1.x"`) jusqu'à la `1.0.0`.

**Ce qui déclenchera la 1.0.0** — ce n'est pas une date, c'est une condition :
un **second adaptateur réel** en production. Tant que le routeur n'a qu'un seul
fournisseur, son repli en cascade n'a nulle part où aller, et promettre une API
stable autour d'une mécanique non éprouvée serait prématuré.

---

## Politique de prise en charge

### Avant la 1.0.0

Seule la dernière version mineure reçoit des correctifs.

### À partir de la 1.0.0

| | |
|---|---|
| Majeure courante | correctifs de fonctionnement et de sécurité |
| Majeure précédente | correctifs de **sécurité uniquement**, pendant **12 mois** après la sortie de la suivante |
| Antérieures | aucune prise en charge |

Les titulaires d'une licence commerciale peuvent négocier une prise en charge
étendue : `contact@relayops.africa`.

---

## Dépréciation

Rien ne disparaît sans préavis.

1. **Annonce.** L'élément est marqué `@deprecated` dans le code — donc visible
   dans l'éditeur de tout utilisateur — et listé dans le CHANGELOG, avec son
   remplacement.
2. **Délai.** Au moins **une version mineure** et **90 jours** entre l'annonce
   et le retrait. L'élément continue de fonctionner pendant tout ce temps.
3. **Retrait.** Dans la majeure suivante, jamais avant.

Une seule exception : si un élément est la cause d'une **faille de sécurité ou
d'un risque de double paiement**, il peut être corrigé immédiatement, y compris
en rompant la compatibilité. La correction sera documentée comme telle. Nous
préférons casser une intégration que laisser partir de l'argent deux fois.

---

## Node

| Version de Sankoré | Node pris en charge |
|---|---|
| `0.1.x` | **≥ 20** pour le paquet publié |

Le paquet publié est du JavaScript ESM compilé avec ses déclarations de types :
aucun drapeau, aucune dépendance d'exécution. La CI vérifie à chaque commit que
le `dist/` s'importe et fonctionne sur Node 20.

Le **développement** demande Node 22.6+ : les sources s'exécutent directement en
TypeScript, sans étape de compilation.

Relever le socle minimal de Node est une **rupture majeure**. Nous ne le ferons
que pour une version de Node arrivée en fin de vie.

---

## Ce que la CI garantit à chaque commit

Un acheteur peut vérifier chacun de ces points dans
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) :

- conventions du projet (`npm run lint`) ;
- cohérence entre `package.json` et la constante `VERSION` ;
- types en mode strict, dont `exactOptionalPropertyTypes` et
  `noUncheckedIndexedAccess` ;
- suite de tests complète avec **seuils de couverture** : 95 % des lignes, 85 %
  des branches, 90 % des fonctions — un recul fait échouer la CI ;
- **zéro dépendance d'exécution**, vérifié et non promis ;
- le paquet empaqueté s'installe et fonctionne dans un projet tiers vierge ;
- le paquet n'embarque ni sources TypeScript, ni tests, ni données internes ;
- `npm audit` sur la surface réellement installée.

---

© 2026 RelayOps — Bamako, Mali.
