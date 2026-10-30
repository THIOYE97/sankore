# Politique de sécurité

Sankoré manipule des ordres de paiement. Une faille ici ne coûte pas des
données : elle coûte de l'argent, celui de nos utilisateurs et de leurs clients.
Nous traitons les signalements en conséquence.

---

## Signaler une vulnérabilité

**N'ouvrez pas d'issue publique.** Écrivez à :

**security@relayops.africa** — ou, à défaut, **contact@relayops.africa**

Objet suggéré : `[Sankoré] vulnérabilité`.

Ce qui nous aide à aller vite :

- la version de Sankoré et de Node ;
- l'adaptateur concerné, s'il y en a un ;
- un scénario reproductible, même approximatif ;
- votre évaluation de l'impact — en particulier : est-ce que cela peut faire
  **partir de l'argent deux fois**, **le faire partir au mauvais endroit**, ou
  **faire croire qu'un paiement a abouti alors qu'il a échoué** ?

### Nos engagements de délai

| | |
|---|---|
| Accusé de réception | **72 heures** ouvrées |
| Première évaluation | **7 jours** |
| Correctif pour une faille critique | **14 jours**, ou un contournement documenté dans le même délai |
| Publication coordonnée | après le correctif, à une date convenue avec vous |

Nous créditons les personnes qui signalent, sauf demande contraire. Nous n'avons
pas de programme de prime : nous sommes une petite équipe à Bamako, et nous
préférons le dire plutôt que de le laisser croire.

---

## Versions prises en charge

| Version | Correctifs de sécurité |
|---|---|
| `0.1.x` | ✅ |
| `< 0.1` | ❌ |

Avant la `1.0.0`, seule la dernière version mineure reçoit des correctifs. Après
la `1.0.0`, la politique passera à : dernière majeure, plus la précédente
pendant douze mois. Voir [VERSIONING.md](VERSIONING.md).

---

## Ce que Sankoré garantit — et ce qu'il ne garantit pas

Un audit de sécurité commence par savoir où s'arrête la bibliothèque. Voici la
frontière, sans ambiguïté.

### Ce que Sankoré prend en charge

| | |
|---|---|
| **Aucune dépendance d'exécution** | La surface d'attaque par la chaîne d'approvisionnement est nulle. C'est vérifié en CI, pas promis dans un README. |
| **Comparaison de signatures en temps constant** | `verifyHmacSignature` emploie `timingSafeEqual`. Une comparaison naïve `a === b` fuit de l'information par son temps d'exécution. |
| **Vérification sur le corps brut** | Les webhooks sont authentifiés sur les octets reçus, jamais sur un objet re-sérialisé : `JSON.stringify(JSON.parse(x)) !== x`. |
| **Anti-rejeu des webhooks** | `WebhookInbox` dédoublonne par identifiant d'événement, ou par empreinte SHA-256 du corps à défaut. |
| **Secrets jamais journalisés** | `redact()` supprime clés d'API, jetons, OTP, codes PIN et signatures ; il masque les données personnelles. `PaymentError.toJSON()` ne divulgue rien de la réponse du fournisseur. |
| **Pas de références métier dans les URL observées** | `scrubPath()` retire la chaîne de requête avant toute observation. |
| **Mode `sandbox` par défaut** | Chez Hub2, c'est un en-tête qui choisit le monde réel. Se tromper ne doit jamais coûter d'argent véritable. |
| **Aucune lecture de `process.env`** | Toute la configuration passe en argument. Aucun secret n'est capté implicitement. |

### Ce qui reste à votre charge

| | |
|---|---|
| **Le stockage de vos secrets** | Sankoré reçoit une clé d'API en mémoire. Son coffre, sa rotation et ses droits d'accès sont de votre ressort. |
| **L'exposition de votre point d'entrée webhook** | HTTPS, pare-feu, limitation de débit en bordure. |
| **Le verrou d'idempotence partagé** | `MemoryIdempotencyStore` ne protège qu'**un seul processus**. Derrière un répartiteur de charge, il ne protège rien. Utilisez `SqlIdempotencyStore` ou une implémentation équivalente. |
| **La vérification de signature Hub2** | Hub2 signe dans `X-Signature` mais ne publie ni l'algorithme ni l'encodage. Nous refusons d'inventer une vérification qui donnerait une fausse assurance : fournissez `verifyWebhook`, obtenu auprès de leur support. **Sans elle, `parseWebhook` normalise sans authentifier.** |
| **Vos propres effets de bord** | Ce que vous faites dans `WebhookInbox.save()` — notifier, débiter un stock, écrire en comptabilité — doit tolérer d'être rejoué, même si nous faisons tout pour que cela n'arrive pas. |

---

## Choix de conception à connaître avant un audit

Trois décisions surprennent en revue et sont délibérées.

### 1. `network_timeout` n'est pas rejouable

Un délai dépassé ne dit **rien** de ce qui s'est passé chez le fournisseur. Le
virement a peut-être abouti. Le rejouer, c'est payer deux fois.

Conséquence : le verrou d'idempotence **garde la clé prise** et passe en
`needs_reconciliation`. Un rejeu lève `ReconciliationRequiredError` jusqu'à ce
que `fetchStatus()` ait tranché. C'est moins commode qu'une clé libérée ; c'est
la seule conduite défendable devant un contrôle de caisse.

### 2. Une exception inattendue est traitée comme incertaine

Si un adaptateur lève autre chose qu'une `PaymentError` — un `TypeError`, un
bogue de notre côté — la clé n'est **pas** relâchée. L'exception a pu survenir
après que la requête HTTP a abouti. Un bogue ne doit pas se payer en double
virement.

### 3. Une création HTTP n'est jamais rejouée automatiquement

`maxRetries: 0` sur tout `POST` qui engage un mouvement d'argent. Un 502 sur une
création ne prouve pas que rien n'est parti. Les **lectures**, elles, sont
rejouées normalement, avec backoff et jitter.

---

## Divulgation

Nous pratiquons la divulgation coordonnée. Nous vous demandons de ne pas rendre
public avant qu'un correctif soit disponible, et nous nous engageons à ne pas
faire traîner.

Si un signalement reste sans réponse de notre part au-delà de **14 jours**, vous
êtes libre de publier. Un silence de notre côté n'est pas une raison de laisser
des utilisateurs exposés.

---

© 2026 RelayOps — Bamako, Mali. `security@relayops.africa`
