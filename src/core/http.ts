/**
 * Mécanique HTTP partagée par tous les adaptateurs.
 *
 * C'est la partie difficile d'une intégration de paiement — pas l'appel lui-même,
 * mais tout ce qui l'entoure : que faire quand ça traîne, quand ça échoue,
 * quand on ne sait pas. Chaque adaptateur qui la réécrit se trompe autrement.
 *
 * Règle structurante, identique à celle du routeur : on ne rejoue QUE les
 * erreurs dont on est certain qu'elles n'ont rien engagé en face. Un délai
 * dépassé n'en fait pas partie.
 */

import { PaymentError } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { safeObserver, scrubPath, type Observer } from './observability.ts';
import type { RateLimiter } from './limiter.ts';
import { USER_AGENT } from './version.ts';

export interface HttpOptions {
    baseUrl: string;
    /** Délai avant abandon d'une requête. 15 s par défaut. */
    timeoutMs?: number;
    /** Nombre de reprises sur erreur rejouable. 2 par défaut. */
    maxRetries?: number;
    /** Délai initial du backoff exponentiel. 300 ms par défaut. */
    retryBaseMs?: number;
    /** Plafond d'une attente entre deux reprises. 20 s par défaut. */
    maxRetryDelayMs?: number;
    defaultHeaders?: Record<string, string>;
    /**
     * Limiteur de débit partagé avec les autres appels vers le même fournisseur.
     *
     * À l'échelle d'un processus : deux `HttpClient` visant le même agrégateur
     * doivent recevoir le MÊME limiteur, sans quoi chacun respecte la limite de
     * son côté et le fournisseur en voit le double.
     */
    limiter?: RateLimiter;
    /** Récepteur d'observations. Aucun par défaut. */
    observer?: Observer;
    /** Injectable pour les tests — évite tout réseau. */
    fetchImpl?: typeof fetch;
    /** Source d'aléa du jitter. Injectable pour rendre les tests déterministes. */
    random?: () => number;
    /** Attente injectable, pour des tests sans attente réelle. */
    sleep?: (ms: number) => Promise<void>;
}

export interface HttpRequest {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    /** Transmise en en-tête d'idempotence quand le fournisseur le supporte. */
    idempotencyKey?: string;
    /**
     * Surcharge le nombre de reprises pour CETTE requête.
     *
     * À mettre à 0 sur toute requête qui crée un mouvement d'argent : un 502 sur
     * un POST de création ne dit pas que rien n'a été engagé. Lire est rejouable,
     * écrire ne l'est pas — cette distinction se décide par requête, pas par client.
     */
    maxRetries?: number;
    /** Surcharge le délai d'attente pour cette requête. */
    timeoutMs?: number;
    /**
     * Annulation par l'appelant — arrêt du processus, abandon de la requête HTTP
     * entrante, délai global de l'opération dépassé.
     *
     * Attention : annuler une ÉCRITURE ne l'annule que chez nous. Le fournisseur
     * a pu la recevoir. C'est pourquoi une annulation est traduite en
     * `network_timeout` et non en erreur bénigne — elle impose une réconciliation,
     * exactement comme un délai dépassé.
     */
    signal?: AbortSignal;
}

export interface HttpResponse {
    status: number;
    body: unknown;
    headers: Record<string, string>;
}

/** Traduit un statut HTTP en code d'erreur normalisé. */
export function mapHttpStatus(status: number): ErrorCode {
    if (status === 401 || status === 403) return 'authentication_failed';
    if (status === 400 || status === 422) return 'invalid_request';
    // 404 signifie « cette ressource n'existe pas chez le fournisseur », ce qui
    // arrive surtout en interrogeant une référence inconnue. Le traduire en
    // `invalid_account` annoncerait au client que SON numéro est invalide — un
    // message faux, pour une cause qui est souvent de notre côté.
    if (status === 404 || status === 410) return 'not_found';
    if (status === 409) return 'duplicate_request';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'provider_unavailable';
    return 'provider_error';
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Lit l'en-tête `Retry-After`, dans ses deux formes autorisées : un nombre de
 * secondes, ou une date HTTP.
 *
 * Deviner l'attente quand le fournisseur l'a dite est une faute : insister plus
 * tôt qu'annoncé est précisément ce qui transforme une limite de débit
 * temporaire en clé d'API suspendue.
 */
export function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        return Number.isFinite(seconds) ? seconds * 1000 : undefined;
    }

    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    return Math.max(0, at - now);
}

export class HttpClient {
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly maxRetries: number;
    private readonly retryBaseMs: number;
    private readonly maxRetryDelayMs: number;
    private readonly defaultHeaders: Record<string, string>;
    private readonly fetchImpl: typeof fetch;
    private readonly limiter?: RateLimiter;
    private readonly observe: Observer;
    private readonly random: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(opts: HttpOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.timeoutMs = opts.timeoutMs ?? 15_000;
        this.maxRetries = opts.maxRetries ?? 2;
        this.retryBaseMs = opts.retryBaseMs ?? 300;
        this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 20_000;
        this.defaultHeaders = opts.defaultHeaders ?? {};
        this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
        if (opts.limiter) this.limiter = opts.limiter;
        this.observe = safeObserver(opts.observer);
        this.random = opts.random ?? Math.random;
        this.sleep = opts.sleep ?? defaultSleep;
    }

    /**
     * Délai avant la reprise `attempt` (1 pour la première reprise).
     *
     * Backoff exponentiel **avec jitter complet** : l'attente est tirée au
     * hasard entre 0 et le plafond exponentiel. Sans jitter, mille requêtes
     * interrompues par la même panne repartent toutes à la même milliseconde et
     * achèvent le fournisseur au moment précis où il se relève. Le jitter est ce
     * qui évite de transformer une reprise en seconde attaque.
     *
     * Un `Retry-After` annoncé par le fournisseur prime toujours : on ne
     * revient jamais plus tôt que ce qu'il a demandé.
     */
    private retryDelay(attempt: number, retryAfterMs?: number): number {
        const ceiling = Math.min(this.retryBaseMs * 2 ** (attempt - 1), this.maxRetryDelayMs);
        const jittered = Math.round(this.random() * ceiling);
        const floor = retryAfterMs ?? 0;
        return Math.min(Math.max(jittered, floor), this.maxRetryDelayMs);
    }

    async request(req: HttpRequest, providerName: string): Promise<HttpResponse> {
        let lastError: PaymentError | undefined;
        const maxRetries = req.maxRetries ?? this.maxRetries;
        const path = scrubPath(req.path);
        const started = Date.now();

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = this.retryDelay(attempt, lastError?.retryAfterMs);
                this.observe({
                    kind: 'http.retry',
                    at: Date.now(),
                    provider: providerName,
                    method: req.method,
                    path,
                    attempt: attempt + 1,
                    code: lastError?.code,
                    detail: { delayMs: delay, retryAfterMs: lastError?.retryAfterMs },
                });
                await this.sleep(delay);
                // Une annulation survenue pendant l'attente doit être honorée :
                // repartir sur le réseau après coup serait un appel de trop.
                this.assertNotAborted(req.signal, providerName);
            }

            if (this.limiter) {
                const limiterOpts: { signal?: AbortSignal; provider: string } = { provider: providerName };
                if (req.signal) limiterOpts.signal = req.signal;
                await this.limiter.acquire(limiterOpts);
            }

            this.observe({
                kind: 'http.request',
                at: Date.now(),
                provider: providerName,
                method: req.method,
                path,
                attempt: attempt + 1,
            });

            try {
                return await this.once(req, providerName, attempt + 1);
            } catch (err) {
                const pe = err instanceof PaymentError
                    ? err
                    : new PaymentError({ code: 'unknown', provider: providerName, cause: err });
                lastError = pe;

                // On ne rejoue QUE ce dont on est certain qu'il n'a rien engagé.
                // Un timeout sort d'ici immédiatement : le paiement a pu partir.
                if (!pe.retryable || attempt === maxRetries) {
                    this.observe({
                        kind: 'http.error',
                        at: Date.now(),
                        provider: providerName,
                        method: req.method,
                        path,
                        attempt: attempt + 1,
                        code: pe.code,
                        providerCode: pe.providerCode,
                        durationMs: Date.now() - started,
                        detail: { retryable: pe.retryable, exhausted: pe.retryable && attempt === maxRetries },
                    });
                    throw pe;
                }
            }
        }

        throw lastError ?? new PaymentError({ code: 'unknown', provider: providerName });
    }

    private assertNotAborted(signal: AbortSignal | undefined, providerName: string): void {
        if (!signal?.aborted) return;
        throw new PaymentError({
            code: 'network_timeout',
            provider: providerName,
            message: `appel vers ${providerName} annulé par l'appelant — statut à vérifier`,
        });
    }

    private async once(req: HttpRequest, providerName: string, attempt: number): Promise<HttpResponse> {
        this.assertNotAborted(req.signal, providerName);

        const timeoutMs = req.timeoutMs ?? this.timeoutMs;
        const controller = new AbortController();

        // Deux causes d'abandon, un seul signal pour `fetch`. On retient
        // laquelle a joué : un délai dépassé et une annulation de l'appelant
        // demandent le même soin, mais pas le même message au support.
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        const onExternalAbort = () => controller.abort();
        if (req.signal) req.signal.addEventListener('abort', onExternalAbort, { once: true });

        const headers: Record<string, string> = {
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': USER_AGENT,
            ...this.defaultHeaders,
            ...req.headers,
        };
        if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;

        const started = Date.now();

        try {
            const init: RequestInit = {
                method: req.method,
                headers,
                signal: controller.signal,
            };
            if (req.body !== undefined) init.body = JSON.stringify(req.body);

            const res = await this.fetchImpl(`${this.baseUrl}${req.path}`, init);

            const text = await res.text();
            let body: unknown = text;
            try { body = text ? JSON.parse(text) : null; } catch { /* garder le texte brut */ }

            const outHeaders: Record<string, string> = {};
            res.headers.forEach((v, k) => { outHeaders[k.toLowerCase()] = v; });

            this.observe({
                kind: 'http.response',
                at: Date.now(),
                provider: providerName,
                method: req.method,
                path: scrubPath(req.path),
                attempt,
                httpStatus: res.status,
                durationMs: Date.now() - started,
            });

            if (!res.ok) {
                const retryAfterMs = parseRetryAfter(outHeaders['retry-after']);
                const options: {
                    code: ErrorCode; provider: string; providerCode: string;
                    message: string; retryAfterMs?: number;
                } = {
                    code: mapHttpStatus(res.status),
                    provider: providerName,
                    providerCode: String(res.status),
                    message: `${providerName} a répondu ${res.status}`,
                };
                if (retryAfterMs !== undefined) options.retryAfterMs = retryAfterMs;
                throw new PaymentError(options);
            }

            return { status: res.status, body, headers: outHeaders };
        } catch (err) {
            if (err instanceof PaymentError) throw err;
            if (err instanceof Error && err.name === 'AbortError') {
                // Non rejouable par construction, dans les deux cas : on ignore
                // ce qui s'est passé en face.
                const cancelled = !timedOut && req.signal?.aborted === true;
                throw new PaymentError({
                    code: 'network_timeout',
                    provider: providerName,
                    message: cancelled
                        ? `appel vers ${providerName} annulé par l'appelant — statut à vérifier`
                        : `${providerName} n'a pas répondu en ${timeoutMs} ms — statut à vérifier`,
                });
            }
            throw new PaymentError({ code: 'provider_unavailable', provider: providerName, cause: err });
        } finally {
            clearTimeout(timer);
            if (req.signal) req.signal.removeEventListener('abort', onExternalAbort);
        }
    }
}

/**
 * Vérifie une signature HMAC de webhook, en temps constant.
 *
 * La comparaison naïve `a === b` fuit de l'information par son temps
 * d'exécution et permet, en théorie, de reconstruire la signature octet par
 * octet. `timingSafeEqual` ferme cette porte.
 */
export async function verifyHmacSignature(opts: {
    payload: string;
    signature: string;
    secret: string;
    algorithm?: 'sha256' | 'sha512';
}): Promise<boolean> {
    const { createHmac, timingSafeEqual } = await import('node:crypto');
    const algo = opts.algorithm ?? 'sha256';
    const expected = createHmac(algo, opts.secret).update(opts.payload).digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(opts.signature.trim().toLowerCase(), 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
