/**
 * Remi Vault — Stripe Payment Forwarding toward Resy book calls.
 *
 * Requires Stripe account onboarding for Payment Forwarding and an allowlisted
 * destination URL. Each forwarding call MUST use a fresh Stripe idempotency key
 * so retries do not double-charge or double-book downstream.
 */

import crypto from 'node:crypto';
import Stripe from 'stripe';

const DEFAULT_RESY_BOOK_URL = 'https://api.resy.com/3/book';

let stripeSingleton: Stripe | null = null;

export function newVaultForwardingIdempotencyKey(prefix = 'remi_vault_fwd'): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

export function getStripeVaultClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is required for Remi Vault forwarding');
  }
  if (!stripeSingleton) {
    stripeSingleton = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
  }
  return stripeSingleton;
}

export interface ForwardResyBookPayload {
  /** Stripe PaymentMethod id (pm_...) to inject per your Stripe forwarding config */
  stripePaymentMethodId: string;
  /** Guest Resy JWT — forwarded as x-resy-auth-token (and universal) on the outbound request */
  resyAuthToken: string;
  /** application/x-www-form-urlencoded body matching Resy POST /3/book */
  bookBody: string;
  /**
   * Stripe idempotency key for forwarding.requests.create — unique per booking attempt.
   * Must differ from any idempotency key on the underlying Resy request.
   */
  forwardingIdempotencyKey: string;
  /** Defaults cover typical PAN/expiry/CVC/name injection templates; adjust to match allowlisted body shape */
  replacements?: Stripe.Forwarding.RequestCreateParams.Replacement[];
}

/** Resolves the destination URL (must match Stripe dashboard allowlist). */
export function getResyForwardBookUrl(): string {
  const custom = process.env.RESY_FORWARD_BOOK_URL?.trim();
  return custom && custom.length > 0 ? custom : DEFAULT_RESY_BOOK_URL;
}

/**
 * Create a Stripe Forwarding Request that POSTs to Resy /3/book with vaulted card fields
 * merged per `replacements` into `bookBody`.
 */
export async function forwardResyBookWithVaultedCard(
  params: ForwardResyBookPayload,
): Promise<Stripe.Forwarding.Request> {
  const stripe = getStripeVaultClient();
  const resyApiKey = process.env.RESY_API_KEY?.trim() || '';

  const headers: Stripe.Forwarding.RequestCreateParams.Request.Header[] = [
    { name: 'authorization', value: `ResyAPI api_key="${resyApiKey}"` },
    { name: 'x-resy-auth-token', value: params.resyAuthToken },
    { name: 'x-resy-universal-auth', value: params.resyAuthToken },
    { name: 'origin', value: 'https://resy.com' },
    { name: 'referer', value: 'https://resy.com/' },
    { name: 'accept', value: 'application/json, text/plain, */*' },
    { name: 'content-type', value: 'application/x-www-form-urlencoded' },
    { name: 'user-agent', value: 'Mozilla/5.0 (compatible; Remi-Vault/1.0)' },
  ];

  return stripe.forwarding.requests.create(
    {
      payment_method: params.stripePaymentMethodId,
      url: getResyForwardBookUrl(),
      replacements: params.replacements ?? ['card_number', 'card_cvc', 'card_expiry', 'cardholder_name'],
      request: {
        body: params.bookBody,
        headers,
      },
    },
    { idempotencyKey: params.forwardingIdempotencyKey },
  );
}
