#!/usr/bin/env node
/**
 * Contrôle des conventions de Sankoré.
 *
 * **Pourquoi pas ESLint.** La question est légitime en revue d'architecture, et
 * la réponse est assumée : l'essentiel de ce qu'ESLint apporterait ici est déjà
 * couvert par `tsc` en mode strict — `noUncheckedIndexedAccess`,
 * `exactOptionalPropertyTypes`, `noImplicitOverride`,
 * `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`. Ce qui resterait, c'est
 * une poignée de règles propres à CE projet, qu'aucune configuration générique
 * ne connaît. Les voici, en cinquante lignes sans dépendance, plutôt qu'en
 * trois cents paquets transitifs sur le chemin de la CI d'un paquet de paiement.
 *
 * Les règles vérifiées ne sont pas stylistiques. Chacune ferme une porte par
 * laquelle un défaut réel est déjà entré quelque part :
 *
 *   1. `any` — dans du code qui manipule de l'argent, un `any` est une
 *      vérification perdue.
 *   2. écriture sur la sortie standard — une bibliothèque n'écrit pas dans les
 *      journaux de son hôte. Elle émet des observations, l'hôte en décide.
 *   3. `process.env` — la configuration est passée en argument, jamais lue dans
 *      l'environnement. C'est ce qui rend un adaptateur testable et multi-compte.
 *   4. extension d'import — les sources importent en `.ts`, et c'est
 *      `rewriteRelativeImportExtensions` qui produit le `.js` publié.
 *   5. `TODO`/`FIXME` — pas dans un paquet publié.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fichiers où une règle est légitimement suspendue, avec sa raison. */
const DEROGATIONS = {
    // `jsonObserver` écrit par défaut sur la sortie standard : c'est sa raison
    // d'être, et l'appelant peut toujours fournir son propre `write`.
    'src/core/observability.ts': ['console'],
};

const REGLES = [
    {
        nom: 'any',
        motif: /(?<![A-Za-z0-9_$])any(?![A-Za-z0-9_$])/,
        // On ne regarde que les positions de type, pas les mots dans les commentaires.
        pertinent: (ligne) => /:\s*any\b|<any>|as any\b|any\[\]/.test(ligne),
        message: 'type `any` — dans du code qui manipule de l’argent, c’est une vérification perdue',
    },
    {
        nom: 'console',
        motif: /\bconsole\.(log|info|warn|error|debug)\b/,
        pertinent: () => true,
        message: 'écriture directe dans les journaux — émets une Observation, l’hôte en décide',
    },
    {
        nom: 'env',
        motif: /\bprocess\.env\b/,
        pertinent: () => true,
        message: 'lecture de process.env — la configuration se passe en argument',
    },
    {
        nom: 'import-extension',
        motif: /from\s+'\.[^']*'/,
        pertinent: (ligne) => {
            const m = ligne.match(/from\s+'(\.[^']*)'/);
            return m !== null && !m[1].endsWith('.ts');
        },
        message: 'import relatif sans extension `.ts`',
    },
    {
        nom: 'todo',
        motif: /\b(TODO|FIXME|XXX|HACK)\b/,
        pertinent: () => true,
        message: 'marqueur de travail inachevé dans du code publié',
    },
];

async function fichiers(dossier) {
    const out = [];
    for (const entree of await readdir(dossier, { withFileTypes: true })) {
        const chemin = join(dossier, entree.name);
        if (entree.isDirectory()) out.push(...await fichiers(chemin));
        else if (entree.name.endsWith('.ts')) out.push(chemin);
    }
    return out;
}

/** Retire commentaires de ligne et de bloc, pour ne juger que du code. */
function sansCommentaires(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (bloc) => bloc.replace(/[^\n]/g, ' '))
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''));
}

const anomalies = [];

for (const chemin of await fichiers(join(racine, 'src'))) {
    const rel = relative(racine, chemin);
    const dispenses = DEROGATIONS[rel] ?? [];
    const source = await readFile(chemin, 'utf8');
    const lignes = sansCommentaires(source);

    // Tout module du cœur doit s'ouvrir sur un commentaire qui dit POURQUOI il
    // existe. C'est la convention la plus utile du projet : elle est ce qui
    // rend le code auditable par quelqu'un qui n'était pas là.
    if (!source.startsWith('/**')) {
        anomalies.push(`${rel}:1  absence d’en-tête expliquant la raison d’être du module`);
    }

    lignes.forEach((ligne, i) => {
        for (const regle of REGLES) {
            if (dispenses.includes(regle.nom)) continue;
            if (!regle.motif.test(ligne)) continue;
            if (!regle.pertinent(ligne)) continue;
            anomalies.push(`${rel}:${i + 1}  ${regle.message}`);
        }
    });
}

if (anomalies.length > 0) {
    console.error(`✗ ${anomalies.length} anomalie(s) de convention :\n`);
    for (const a of anomalies) console.error(`    ${a}`);
    console.error('');
    process.exit(1);
}

console.log('✓ conventions respectées');
