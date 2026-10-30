/**
 * Version de la bibliothèque, en dur.
 *
 * On ne lit pas `package.json` : en ESM cela exige soit un attribut d'import
 * encore instable, soit une lecture de fichier qui échoue dès que le paquet est
 * empaqueté par un bundler. Une constante traverse tous les environnements.
 *
 * La cohérence avec `package.json` n'est pas laissée à la vigilance de
 * quelqu'un : `npm run check:version` la vérifie, et la CI refuse une
 * publication où les deux divergent.
 */
export const VERSION = '0.1.0';

/**
 * En-tête `User-Agent` envoyé par défaut.
 *
 * Côté fournisseur, savoir quelle version d'un client parle est ce qui permet
 * d'imputer une anomalie plutôt que de la découvrir. Les agrégateurs avec qui
 * on travaille nous l'ont demandé explicitement.
 */
export const USER_AGENT = `sankore/${VERSION} (+https://relayops.africa)`;
