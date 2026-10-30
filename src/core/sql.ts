/**
 * Pont SQL minimal — brancher une base sans rien lui imposer.
 *
 * Les deux garanties qui ne tiennent pas en mémoire d'un seul processus — le
 * verrou d'idempotence et le journal anti-rejeu des webhooks — ont besoin d'un
 * stockage partagé. La tentation serait d'en faire dépendre le paquet de `pg`.
 * On ne le fait pas : le choix de la base appartient à l'hôte, et une
 * bibliothèque de paiement qui traîne un pilote PostgreSQL derrière elle est
 * refusée en revue d'architecture — à juste titre.
 *
 * Sankoré demande donc une seule fonction. L'hôte l'écrit en trois lignes
 * contre le pilote qu'il a déjà :
 *
 * ```ts
 * // pg
 * const run: SqlRunner = async (sql, params) => {
 *   const r = await pool.query(sql, params as unknown[]);
 *   return { rows: r.rows, affected: r.rowCount ?? 0 };
 * };
 *
 * // mysql2/promise — attention au dialecte des paramètres, voir MYSQL_PLACEHOLDER
 * const run: SqlRunner = async (sql, params) => {
 *   const [r] = await pool.query(sql, params as unknown[]);
 *   return Array.isArray(r)
 *     ? { rows: r as Record<string, unknown>[], affected: r.length }
 *     : { rows: [], affected: (r as { affectedRows?: number }).affectedRows ?? 0 };
 * };
 * ```
 */

export interface SqlResult {
    /** Lignes renvoyées par un `SELECT`. Vide pour une écriture. */
    rows: readonly Record<string, unknown>[];
    /**
     * Nombre de lignes affectées par une écriture.
     *
     * Ce nombre n'est pas accessoire : c'est lui qui rend atomiques
     * `INSERT … ON CONFLICT DO NOTHING` et `UPDATE … WHERE state = …`. Un
     * pilote qui rend toujours 0 casse les deux garanties en silence.
     */
    affected: number;
}

export type SqlRunner = (sql: string, params: readonly unknown[]) => Promise<SqlResult>;

/**
 * Fabrique le marqueur du n-ième paramètre (n commence à 1).
 *
 * PostgreSQL attend `$1`, MySQL et SQLite attendent `?`. Rendre cela
 * configurable coûte une fonction et évite à l'hôte de réécrire les requêtes.
 */
export type Placeholder = (index: number) => string;

/** PostgreSQL, CockroachDB : `$1`, `$2`… Valeur par défaut. */
export const PG_PLACEHOLDER: Placeholder = (i) => `$${i}`;

/** MySQL, MariaDB, SQLite : `?` partout. */
export const MYSQL_PLACEHOLDER: Placeholder = () => '?';
