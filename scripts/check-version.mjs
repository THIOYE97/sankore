#!/usr/bin/env node
/**
 * Vérifie que `src/core/version.ts` et `package.json` annoncent la même version.
 *
 * La constante existe parce qu'un paquet ESM ne peut pas lire son propre
 * `package.json` de façon portable (voir `src/core/version.ts`). Deux sources de
 * vérité, donc — et deux sources de vérité qui divergent finissent toujours par
 * diverger. Ce contrôle tourne en CI et bloque la publication plutôt que de
 * livrer un `User-Agent` qui mente sur la version en production.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(await readFile(join(racine, 'package.json'), 'utf8'));
const source = await readFile(join(racine, 'src/core/version.ts'), 'utf8');

const trouve = source.match(/export const VERSION = '([^']+)'/);

if (!trouve) {
    console.error('✗ src/core/version.ts : constante VERSION introuvable');
    process.exit(1);
}

const [, declaree] = trouve;

if (declaree !== pkg.version) {
    console.error(
        `✗ versions divergentes\n`
        + `    package.json         : ${pkg.version}\n`
        + `    src/core/version.ts  : ${declaree}\n\n`
        + `  Corrige src/core/version.ts, puis relance.`
    );
    process.exit(1);
}

console.log(`✓ version cohérente : ${pkg.version}`);
