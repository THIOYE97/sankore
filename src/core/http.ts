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

export interface HttpOptions {
    baseUrl: string;
    /** Délai avant abandon d'une requête. 15 s par défaut. */
    timeoutMs?: number;
    /** Nombre de reprises sur erreur rejouable. 2 par défaut. */
    maxRetries?: number;
    /** Délai initial du backoff exponentiel. 300 ms par défaut. */
    retryBaseMs?: number;
    defaultHeaders?: Record<string, string>;
    /** Injectable pour les tests — évite tout réseau. */
    fetchImpl?: typeof fetch;
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
    if (status === 404) return 'invalid_account';
    if (status === 409) return 'duplicate_request';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'provider_unavailable';
    return 'provider_error';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpClient {
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly maxRetries: number;
    private readonly retryBaseMs: number;
    private readonly defaultHeaders: Record<string, string>;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: HttpOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.timeoutMs = opts.timeoutMs ?? 15_000;
        this.maxRetries = opts.maxRetries ?? 2;
        this.retryBaseMs = opts.retryBaseMs ?? 300;
        this.defaultHeaders = opts.defaultHeaders ?? {};
        this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    }

    async request(req: HttpRequest, providerName: string): Promise<HttpResponse> {
        let lastError: PaymentError | undefined;
        const maxRetries = req.maxRetries ?? this.maxRetries;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                // Backoff exponentiel : 300 ms, 600 ms, 1200 ms…
                await sleep(this.retryBaseMs * 2 ** (attempt - 1));
            }

            try {
                return await this.once(req, providerName);
            } catch (err) {
                const pe = err instanceof PaymentError
                    ? err
                    : new PaymentError({ code: 'unknown', provider: providerName, cause: err });
                lastError = pe;

                // On ne rejoue QUE ce dont on est certain qu'il n'a rien engagé.
                // Un timeout sort d'ici immédiatement : le paiement a pu partir.
                if (!pe.retryable) throw pe;
            }
        }

        throw lastError ?? new PaymentError({ code: 'unknown', provider: providerName });
    }

    private async once(req: HttpRequest, providerName: string): Promise<HttpResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const headers: Record<string, string> = {
            'content-type': 'application/json',
            accept: 'application/json',
            ...this.defaultHeaders,
            ...req.headers,
        };
        if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;

        try {
            const res = await this.fetchImpl(`${this.baseUrl}${req.path}`, {
                method: req.method,
                headers,
                body: req.body === undefined ? undefined : JSON.stringify(req.body),
                signal: controller.signal,
            });

            const text = await res.text();
            let body: unknown = text;
            try { body = text ? JSON.parse(text) : null; } catch { /* garder le texte brut */ }

            if (!res.ok) {
                throw new PaymentError({
                    code: mapHttpStatus(res.status),
                    provider: providerName,
                    providerCode: String(res.status),
                    message: `${providerName} a répondu ${res.status}`,
                });
            }

            const outHeaders: Record<string, string> = {};
            res.headers.forEach((v, k) => { outHeaders[k.toLowerCase()] = v; });
            return { status: res.status, body, headers: outHeaders };
        } catch (err) {
            if (err instanceof PaymentError) throw err;
            if (err instanceof Error && err.name === 'AbortError') {
                // Non rejouable par construction : on ignore ce qui s'est passé en face.
                throw new PaymentError({
                    code: 'network_timeout',
                    provider: providerName,
                    message: `${providerName} n'a pas répondu en ${this.timeoutMs} ms — statut à vérifier`,
                });
            }
            throw new PaymentError({ code: 'provider_unavailable', provider: providerName, cause: err });
        } finally {
            clearTimeout(timer);
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
