/**
 * Réconciliation — constater ce qui s'est réellement passé.
 *
 * Toute la bibliothèque est construite autour d'un refus : on ne rejoue jamais
 * une opération dont on ignore le sort. `network_timeout` n'est pas rejouable,
 * et le verrou d'idempotence garde la clé prise. Ce refus laisse donc, par
 * construction, un reste à traiter : des références en suspens dont il faut
 * aller chercher la vérité chez le fournisseur.
 *
 * Sans outil, ce reste finit en requête SQL écrite à la main un vendredi soir,
 * ou en rien du tout. C'est ce « rien du tout » qui produit les écarts de
 * caisse qu'on ne sait plus expliquer six mois plus tard.
 *
 * **Le réconciliateur ne paie jamais.** Il n'appelle que `fetchStatus()`, une
 * lecture. C'est la seule opération qu'on peut se permettre de rejouer autant
 * de fois qu'il le faut.
 *
 * Trois issues possibles, et la troisième est la plus utile :
 *
 * - **état final constaté** -> la clé d'idempotence passe en `completed` et
 *   portera ce résultat. L'incertitude est levée.
 * - **toujours en cours** -> on repassera. Rien n'est tranché, rien ne change.
 * - **inconnu du fournisseur** (`not_found`) -> la requête ne lui est JAMAIS
 *   parvenue. Rien n'a été engagé, la clé est relâchée, et l'application peut
 *   légitimement retenter. C'est le seul cas où rejouer après un timeout est
 *   sûr — parce qu'on a vérifié, au lieu de supposer.
 */

import { PaymentError } from './errors.ts';
import { isFinal } from './status.ts';
import type { PaymentStatus } from './status.ts';
import type { PaymentProvider, PaymentResult } from './provider.ts';
import { safeObserver, type Observation, type Observer } from './observability.ts';
import { resolveReconciliation, type IdempotencyStore } from './idempotency.ts';

/** Une opération à réconcilier. */
export interface ReconcileTask {
    /** Référence applicative — c'est par elle qu'on interroge le fournisseur. */
    reference: string;
    /**
     * Nom du fournisseur qui a (peut-être) reçu l'opération.
     *
     * Indispensable : interroger le mauvais fournisseur renvoie « inconnu », ce
     * qui serait lu comme « rien n'est parti » et autoriserait un rejeu. C'est
     * la raison pour laquelle le nom du fournisseur retenu doit être persisté
     * par l'application AU MOMENT du routage, pas déduit après coup.
     */
    provider: string;
    /** Clé d'idempotence, si elle diffère de la référence. */
    key?: string;
}

export type ReconcileOutcome =
    /** État final constaté. L'incertitude est levée. */
    | { outcome: 'resolved'; reference: string; status: PaymentStatus; result: PaymentResult }
    /** Toujours en cours chez le fournisseur. À reprendre plus tard. */
    | { outcome: 'pending'; reference: string; status: PaymentStatus; result: PaymentResult }
    /** Le fournisseur ne connaît pas cette opération : elle ne lui est jamais parvenue. */
    | { outcome: 'never_sent'; reference: string; released: boolean }
    /** Fournisseur introuvable dans le registre — erreur de configuration. */
    | { outcome: 'unknown_provider'; reference: string; provider: string }
    /** Impossible d'interroger le fournisseur. L'incertitude demeure. */
    | { outcome: 'unreachable'; reference: string; error: PaymentError };

export interface ReconcilerOptions {
    /**
     * Résout un nom de fournisseur. Un `Router` convient tel quel.
     *
     * On passe par une indirection plutôt que par une liste figée parce que la
     * réconciliation tourne souvent dans un AUTRE processus que l'API — un
     * worker, une tâche planifiée — et doit y retrouver les mêmes fournisseurs.
     */
    providers: { provider(name: string): PaymentProvider | null };
    /**
     * Store d'idempotence à mettre à jour quand l'incertitude est levée.
     *
     * Facultatif : sans lui, le réconciliateur se contente de CONSTATER. Avec
     * lui, il clôt le dossier — c'est ce qui débloque les rejeux légitimes.
     */
    store?: IdempotencyStore;
    observer?: Observer;
    /** Opérations réconciliées en parallèle dans un lot. 4 par défaut. */
    concurrency?: number;
    now?: () => number;
}

export class Reconciler {
    private readonly providers: { provider(name: string): PaymentProvider | null };
    private readonly store?: IdempotencyStore;
    private readonly observe: Observer;
    private readonly concurrency: number;
    private readonly now: () => number;

    constructor(opts: ReconcilerOptions) {
        this.providers = opts.providers;
        if (opts.store) this.store = opts.store;
        this.observe = safeObserver(opts.observer);
        this.concurrency = Math.max(1, opts.concurrency ?? 4);
        this.now = opts.now ?? Date.now;
    }

    /**
     * Réconcilie UNE opération : une lecture, un constat, et la mise à jour du
     * verrou si l'incertitude est levée.
     *
     * Ne lève pas. Toutes les issues, y compris l'échec d'interrogation, sont
     * rendues comme valeur : une boucle de réconciliation qui s'arrête sur la
     * première exception laisse les suivantes en suspens, c'est-à-dire
     * exactement le problème qu'elle devait résoudre.
     */
    async reconcile(task: ReconcileTask): Promise<ReconcileOutcome> {
        const key = task.key ?? task.reference;

        this.observe({
            kind: 'reconcile.started',
            at: this.now(),
            provider: task.provider,
            reference: task.reference,
            detail: { key },
        });

        const provider = this.providers.provider(task.provider);
        if (!provider) {
            this.observe({
                kind: 'reconcile.failed',
                at: this.now(),
                provider: task.provider,
                reference: task.reference,
                detail: { reason: 'fournisseur absent du registre' },
            });
            return { outcome: 'unknown_provider', reference: task.reference, provider: task.provider };
        }

        let observed: PaymentResult;
        try {
            observed = await provider.fetchStatus(task.reference);
        } catch (err) {
            const pe = err instanceof PaymentError
                ? err
                : new PaymentError({ code: 'unknown', provider: task.provider, cause: err });

            // `not_found` est un VERDICT, pas une panne : le fournisseur affirme
            // ne rien connaître de cette référence. Rien n'a donc été engagé, et
            // la clé peut être relâchée en sûreté — le seul chemin par lequel un
            // rejeu après timeout devient légitime.
            if (pe.code === 'not_found') {
                const released = await this.releaseIfPossible(key);
                this.observe({
                    kind: 'reconcile.resolved',
                    at: this.now(),
                    provider: task.provider,
                    reference: task.reference,
                    code: pe.code,
                    detail: { key, neverSent: true, released },
                });
                return { outcome: 'never_sent', reference: task.reference, released };
            }

            this.observe({
                kind: 'reconcile.failed',
                at: this.now(),
                provider: task.provider,
                reference: task.reference,
                code: pe.code,
                detail: { key },
            });
            return { outcome: 'unreachable', reference: task.reference, error: pe };
        }

        if (!isFinal(observed.status)) {
            this.observe({
                kind: 'reconcile.pending',
                at: this.now(),
                provider: task.provider,
                reference: task.reference,
                paymentStatus: observed.status,
                detail: { key, action: observed.action?.type },
            });
            return { outcome: 'pending', reference: task.reference, status: observed.status, result: observed };
        }

        if (this.store) {
            await resolveReconciliation(key, this.store, observed, isFinal);
        }

        const resolved: Observation = {
            kind: 'reconcile.resolved',
            at: this.now(),
            provider: task.provider,
            reference: task.reference,
            paymentStatus: observed.status,
            detail: { key, closed: this.store !== undefined },
        };
        if (observed.error) resolved.code = observed.error.code;
        this.observe(resolved);

        return { outcome: 'resolved', reference: task.reference, status: observed.status, result: observed };
    }

    private async releaseIfPossible(key: string): Promise<boolean> {
        if (!this.store) return false;
        await this.store.release(key);
        return true;
    }

    /**
     * Réconcilie un lot, avec un parallélisme borné.
     *
     * Le plafond n'est pas une précaution de style : les limites de débit des
     * agrégateurs ouest-africains sont basses, et lâcher cinq cents lectures
     * d'un coup au réveil d'un worker fait sauter la clé d'API — au moment
     * précis où l'on a le plus besoin de pouvoir interroger.
     */
    async run(tasks: readonly ReconcileTask[]): Promise<ReconcileOutcome[]> {
        const outcomes: ReconcileOutcome[] = new Array(tasks.length);
        let cursor = 0;

        const worker = async (): Promise<void> => {
            for (;;) {
                const index = cursor++;
                if (index >= tasks.length) return;
                const task = tasks[index];
                if (!task) return;
                outcomes[index] = await this.reconcile(task);
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(this.concurrency, tasks.length) }, () => worker())
        );
        return outcomes;
    }

    /**
     * Compte les issues d'un lot — de quoi alimenter une métrique ou un
     * rapport d'astreinte en une ligne.
     */
    static summarize(outcomes: readonly ReconcileOutcome[]): Record<ReconcileOutcome['outcome'], number> {
        const tally: Record<ReconcileOutcome['outcome'], number> = {
            resolved: 0, pending: 0, never_sent: 0, unknown_provider: 0, unreachable: 0,
        };
        for (const o of outcomes) tally[o.outcome] += 1;
        return tally;
    }
}
