---
name: Nouvel adaptateur
about: Proposer la prise en charge d'un agrégateur ou d'un opérateur
title: 'Adaptateur : '
labels: adaptateur
assignees: ''
---

## Le fournisseur

| | |
|---|---|
| Nom | |
| Documentation | <!-- URL, et la date à laquelle vous l'avez lue --> |
| Spécification OpenAPI | <!-- URL, si elle existe --> |
| Bac à sable | <!-- disponible sans contrat ? --> |

## Corridors couverts

<!-- Pays × rail × devise × sens. Ce qui remplira `capabilities()`. -->

| Pays | Rail | Devise | Décaissement | Encaissement | Opérateurs |
|---|---|---|---|---|---|
| | | | | | |

## Les questions qui décident de la faisabilité

<!--
Ce sont celles sur lesquelles une intégration se gagne ou se perd. Répondez même
partiellement : « la documentation ne le dit pas » est une réponse précieuse, et
c'est souvent la vraie.
-->

1. **Idempotence** — le fournisseur accepte-t-il une référence applicative, ou
   une clé d'idempotence ? Que renvoie-t-il sur un doublon ?
2. **Retrouver une opération par NOTRE référence** — possible ? Sans cela, il
   n'y a pas de réconciliation après un timeout, c'est-à-dire pas d'intégration
   sérieuse.
3. **Webhooks** — signés comment ? L'algorithme est-il publié, ou faut-il passer
   par le support ?
4. **Causes d'échec** — la liste est-elle documentée et exhaustive ?
5. **Encaissement** — exige-t-il une action du client (OTP, USSD, redirection) ?
6. **Limites de débit** — connues ? Que se passe-t-il quand on les dépasse :
   429, mise en file silencieuse, suspension de la clé ?
7. **Devises sans subdivision** — comment le fournisseur attend-il un montant en
   XOF ? En unités mineures, ou avec des décimales fantômes ? **C'est l'erreur à
   un facteur 100 qui ne se voit qu'en production.**

## Votre situation

- [ ] je l'utilise en production et je peux tester contre le vrai service
- [ ] j'ai un accès bac à sable
- [ ] je propose l'idée, sans accès
- [ ] je suis prêt à écrire l'adaptateur
