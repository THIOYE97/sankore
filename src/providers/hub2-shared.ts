/**
 * Socle commun aux deux sens de l'intégration Hub2.
 *
 * Décaisser et encaisser sont deux mécaniques très différentes chez Hub2 — un
 * `Transfer` d'un côté, un `PaymentIntent` et ses tentatives de l'autre, avec
 * des statuts et des causes d'échec distincts. Ne sont mis en commun ici que
 * les éléments réellement partagés : l'authentification, les corridors, et deux
 * conversions qui doivent impérativement rester identiques des deux côtés.
 *
 * Références (vérifiées le 5 août 2026) :
 *   - OpenAPI  https://api.hub2.io/docs-json  (v2.156.0)
 *   - Doc      https://docs.hub2.io/
 */

import { Money } from '../core/money.ts';
import type { Currency } from '../core/money.ts';
import { PaymentError } from '../core/errors.ts';
import { HttpClient } from '../core/http.ts';
import type { Capability, CountryCode, Direction } from '../core/provider.ts';

export const DEFAULT_BASE_URL = 'https://api.hub2.io';

/* ------------------------------------------------------------------ *
 * Corridors
 * ------------------------------------------------------------------ */

/**
 * Opérateurs mobile money couverts, relevés sur `GET /data/providers`
 * (endpoint public, sans authentification) le 5 août 2026.
 *
 * Hub2 ne distingue pas le sens dans cette liste : les mêmes opérateurs
 * servent au décaissement et à l'encaissement. Pour router sur la couverture
 * réelle du jour plutôt que sur cette photo, voir `Hub2Provider.fetchCapabilities()`.
 */
export const MOBILE_MONEY: readonly {
    country: CountryCode;
    currency: Currency;
    institutions: readonly string[];
}[] = [
    { country: 'BF', currency: 'XOF', institutions: ['orange', 'mobicash', 'moov', 'wave'] },
    { country: 'BJ', currency: 'XOF', institutions: ['moov', 'mtn', 'celtiis'] },
    { country: 'CF', currency: 'XAF', institutions: ['telecel', 'orange'] },
    { country: 'CG', currency: 'XAF', institutions: ['mtn', 'airtel'] },
    { country: 'CI', currency: 'XOF', institutions: ['orange', 'mtn', 'moov', 'wave'] },
    { country: 'CM', currency: 'XAF', institutions: ['orange', 'mtn'] },
    { country: 'GA', currency: 'XAF', institutions: ['airtel', 'moov', 'mobicash'] },
    { country: 'GN', currency: 'GNF', institutions: ['orange', 'mtn'] },
    { country: 'GQ', currency: 'XAF', institutions: ['muni'] },
    { country: 'ML', currency: 'XOF', institutions: ['orange', 'mobicash'] },
    { country: 'SN', currency: 'XOF', institutions: ['orange', 'free', 'emoney', 'wave'] },
    { country: 'TD', currency: 'XAF', institutions: ['moov', 'airtel'] },
    { country: 'TG', currency: 'XOF', institutions: ['moov', 'togocell'] },
];

/** Décline la table de corridors dans les sens demandés. */
export function buildCapabilities(
    directions: readonly Direction[],
    corridors: typeof MOBILE_MONEY = MOBILE_MONEY
): readonly Capability[] {
    return corridors.flatMap((c) =>
        directions.map((direction) => ({
            rail: 'mobile_money' as const,
            country: c.country,
            currency: c.currency,
            direction,
            institutions: c.institutions,
        }))
    );
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/** Adresses de retour, quand le parcours du client passe par une page externe. */
export interface Hub2RedirectionUrls {
    /** Wave et carte : retour après succès. */
    onSuccess?: string;
    /** Wave et carte : retour après échec. */
    onFailed?: string;
    /** Orange en mode `redirection` : le client a renoncé. */
    onCancel?: string;
    /** Orange en mode `redirection` : le client a cliqué sur le lien de retour. */
    onFinish?: string;
}

export interface Hub2Options {
    /** Clé d'API, depuis le tableau de bord Hub2. En-tête `ApiKey`. */
    apiKey: string;
    /** Identifiant marchand. En-tête `MerchantId`. */
    merchantId: string;
    /** `sandbox` par défaut — le mode `live` doit toujours être un choix explicite. */
    environment?: 'live' | 'sandbox';
    baseUrl?: string;
    /** Nom sous lequel ce fournisseur est connu du routeur. `hub2` par défaut. */
    name?: string;
    timeoutMs?: number;
    /** Reprises sur les requêtes de LECTURE. Les créations ne sont jamais rejouées. */
    maxRetries?: number;
    /** Remplace la table de corridors intégrée. */
    capabilities?: readonly Capability[];
    /** Nom affiché au client à la place de « Hub2 ». Obligatoire pour les agrégateurs. */
    businessName?: string;
    /** Informations sur l'émetteur, transmises dans `origin` lors d'un décaissement. */
    origin?: { name?: string; country?: CountryCode };

    /* --- Encaissement --- */

    /** Adresses de retour par défaut pour les parcours avec redirection. */
    redirection?: Hub2RedirectionUrls;
    /**
     * Chez Orange, force le parcours par redirection au lieu de l'OTP.
     *
     * Le choix n'est pas anodin : en `redirection` le client part sur une page
     * Orange et rien ne revient par `confirm()` — c'est le webhook qui tranche.
     * En OTP, le client dicte un code que l'application renvoie elle-même.
     */
    orangeWorkflow?: 'redirection' | 'otp';
    /**
     * Vérificateur de signature de webhook.
     *
     * Hub2 signe ses webhooks dans l'en-tête `X-Signature`, mais ne publie ni
     * l'algorithme ni l'encodage — la documentation renvoie au support. Plutôt
     * que d'inventer une vérification qui donnerait une fausse assurance, on la
     * délègue : fournis la fonction que le support t'aura indiquée.
     *
     * Sans elle, `parseWebhook` normalise l'événement SANS l'authentifier.
     */
    verifyWebhook?: (rawBody: string, headers: Record<string, string>) => boolean;
    /** Injectable pour les tests — évite tout réseau. */
    fetchImpl?: typeof fetch;
}

/** Monte le client HTTP avec les trois en-têtes d'authentification de Hub2. */
export function buildHttp(opts: Hub2Options, environment: 'live' | 'sandbox'): HttpClient {
    return new HttpClient({
        baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        fetchImpl: opts.fetchImpl,
        defaultHeaders: {
            ApiKey: opts.apiKey,
            MerchantId: opts.merchantId,
            Environment: environment,
        },
    });
}

/* ------------------------------------------------------------------ *
 * Conversions
 * ------------------------------------------------------------------ */

/** Hub2 refuse les références contenant autre chose que ceci (HTTP 400). */
export const REFERENCE_ALLOWED = /^[A-Za-z0-9\-_. ]+$/;

export function assertReference(reference: string, provider: string): void {
    if (REFERENCE_ALLOWED.test(reference)) return;
    throw new PaymentError({
        code: 'invalid_request',
        provider,
        message: `référence « ${reference} » : Hub2 n'accepte que lettres, chiffres, `
            + 'tiret, souligné, point et espace',
    });
}

/**
 * Met le numéro à la forme des exemples Hub2 : `+225xxxxxxxx`.
 *
 * `Account.identifier` est documenté sans le « + » ; on l'ajoute plutôt que de
 * laisser chaque appelant deviner la convention de l'agrégateur. Le seul
 * exemple de la documentation portant un vrai numéro — celui du virement —
 * emploie cette forme, et rien n'indique que l'encaissement en attende une autre.
 */
export function toMsisdn(identifier: string): string {
    return `+${identifier.replace(/[^\d]/g, '')}`;
}

/**
 * Somme les frais libellés dans la devise de l'opération.
 *
 * Les frais d'une autre devise sont IGNORÉS et non convertis : additionner du
 * XOF et de l'EUR produirait un nombre qui ne veut rien dire. `undefined`
 * signifie « aucun frais connu », ce qui n'est pas la même chose que zéro.
 */
export function sumFees(fees: unknown, currency: Currency): Money | undefined {
    if (!Array.isArray(fees)) return undefined;
    let total = Money.zero(currency);
    let matched = false;
    for (const raw of fees as unknown[]) {
        if (typeof raw !== 'object' || raw === null) continue;
        const fee = raw as { amount?: unknown; currency?: unknown };
        if (fee.currency !== currency) continue;
        if (typeof fee.amount !== 'number' || !Number.isInteger(fee.amount)) continue;
        total = total.add(Money.minor(fee.amount, currency));
        matched = true;
    }
    return matched ? total : undefined;
}

/** Retient l'élément le plus récemment créé — les références devraient être uniques. */
export function mostRecent<T extends { createdAt?: unknown }>(list: readonly T[]): T | null {
    if (list.length === 0) return null;
    return list.reduce((latest, item) => {
        const a = typeof item.createdAt === 'string' ? item.createdAt : '';
        const b = typeof latest.createdAt === 'string' ? latest.createdAt : '';
        return a > b ? item : latest;
    });
}
