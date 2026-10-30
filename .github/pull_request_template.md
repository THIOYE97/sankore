## Intention

<!-- Ce que cette PR change, et pourquoi. Une intention par PR. -->

## Rupture de comportement

<!--
LA question la plus importante de cette description.

Le code des utilisateurs continue-t-il de compiler tout en se comportant
autrement ? Un ErrorCode traduit différemment, une erreur devenue rejouable,
une transition désormais autorisée ?

- [ ] aucune
- [ ] oui, décrite ci-dessous avec la manœuvre de migration
-->

## Les règles du projet

<!-- Voir CONTRIBUTING.md. Cochez ce qui s'applique. -->

- [ ] aucune requête créant un mouvement d'argent n'est rejouée automatiquement
- [ ] aucun montant ne transite par un flottant
- [ ] aucune dépendance d'exécution ajoutée
- [ ] aucun secret ni donnée personnelle ne peut atteindre un journal
- [ ] les commentaires expliquent POURQUOI, pas QUOI
- [ ] `npm run verify` passe, couverture comprise
- [ ] CHANGELOG mis à jour sous `[Non publié]`

## Adaptateur fournisseur — si applicable

- [ ] toutes les causes d'échec sont traduites, code brut conservé dans `providerCode`
- [ ] l'en-tête porte l'URL de la spécification et la DATE de vérification
- [ ] ce qui n'est pas couvert est refusé explicitement, avec sa raison
- [ ] tests : rejeu, délai dépassé, webhook en désordre, webhook mal signé,
      statut inconnu

## Comment vous l'avez vérifié

<!-- Tests ajoutés. Si vous avez exercé un vrai fournisseur, dites lequel et
     dans quel mode — sans coller d'identifiants. -->
