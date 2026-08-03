/**
 * Contrat que tout fournisseur de paiement doit honorer.
 *
 * Volontairement découplé de tout ORM, framework ou base de données : un
 * fournisseur reçoit des objets simples et rend des objets simples. C'est ce
 * qui permet de le tester sans réseau et de le réutiliser dans n'importe quel
 * projet — Express, NestJS, Fastify, un worker, une Lambda.
 */

import type { Money, Currency } from './money.ts';
import type { PaymentStatus } from './status.ts';
import type { PaymentError } from './errors.ts';

/** Les rails de paiement couverts. */
export type Rail =
    | 'mobile_money'  // Orange Money, Moov, Wave, MTN MoMo…
    | 'bank'          // virement bancaire
    | 'mfi'           // institution de microfinance — rare hors Afrique de l'Ouest
    | 'wallet'        // portefeuille électronique interne
    | 'card';         // carte bancaire

/** Code pays ISO 3166-1 alpha-2. */
export type CountryCode = string;

/** Sens de l'opération, du point de vue de la plateforme. */
export type Direction =
    | 'payout'   // on envoie de l'argent au bénéficiaire (cash-out)
    | 'payin';   // on encaisse depuis le client (cash-in)

/** Destinataire ou émetteur des fonds. */
export interface Account {
    rail: Rail;
    country: CountryCode;
    /** MSISDN au format international sans « + » (ex. 22370000000) pour le mobile money. */
    identifier: string;
    /** Nom du titulaire, exigé par certains opérateurs. */
    holderName?: string;
    /** Opérateur ou banque précis, quand le rail en compte plusieurs. */
    institution?: string;
}

export interface PaymentRequest {
    /** Référence unique côté application — sert de clé d'idempotence. */
    reference: string;
    direction: Direction;
    amount: Money;
    account: Account;
    /** Libellé transmis au fournisseur quand il l'accepte. */
    label?: string;
    metadata?: Record<string, string>;
}

export interface PaymentResult {
    reference: string;
    status: PaymentStatus;
    /** Identifiant attribué par le fournisseur — indispensable pour la réconciliation. */
    providerReference?: string;
    /** Frais réellement prélevés, quand le fournisseur les communique. */
    fee?: Money;
    /** Erreur normalisée si le statut est `failed`. */
    error?: PaymentError;
    /** Réponse brute, conservée pour l'audit. Jamais interprétée par l'application. */
    raw?: unknown;
}

/** Ce qu'un fournisseur sait faire — interrogé par le routeur. */
export interface Capability {
    rail: Rail;
    country: CountryCode;
    currency: Currency;
    direction: Direction;
    /** Bornes imposées par l'opérateur, en unités mineures. */
    minAmount?: number;
    maxAmount?: number;
    /** Opérateurs couverts sur ce rail ; absent = tous. */
    institutions?: readonly string[];
}

/** Événement de webhook, une fois normalisé. */
export interface WebhookEvent {
    reference: string;
    providerReference?: string;
    status: PaymentStatus;
    error?: PaymentError;
    raw: unknown;
}

export interface PaymentProvider {
    /** Identifiant court et stable : 'bizao', 'intouch', 'hub2'… */
    readonly name: string;

    /** Ce que ce fournisseur prend en charge. Consulté par le routeur. */
    capabilities(): readonly Capability[];

    /** Lance l'opération. Doit être idempotent sur `request.reference`. */
    execute(request: PaymentRequest): Promise<PaymentResult>;

    /**
     * Interroge l'état réel côté fournisseur.
     * C'est la porte de sortie après un timeout : on ne rejoue jamais à
     * l'aveugle, on demande d'abord ce qui s'est vraiment passé.
     */
    fetchStatus(reference: string): Promise<PaymentResult>;

    /**
     * Vérifie la signature d'un webhook et le normalise.
     * Retourne `null` si la signature est invalide — l'appelant doit alors
     * répondre 401 et surtout ne rien modifier.
     */
    parseWebhook(payload: unknown, headers: Record<string, string>): WebhookEvent | null;

    /** Solde disponible, quand le fournisseur l'expose. */
    balance?(currency: Currency, country?: CountryCode): Promise<Money>;
}
