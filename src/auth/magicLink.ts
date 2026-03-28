import crypto from 'node:crypto';
import { createAuthToken, verifyAuthToken, markAuthTokenUsed } from './db.js';
import { redactPhone } from '../utils/redact.js';

const MAGIC_LINK_TTL_MINUTES = 15;

/** When true, try magic link onboarding first (falls back to SMS OTP if delivery fails). Default is SMS-only. */
export function isMagicLinkOnboardingEnabled(): boolean {
  const v = process.env.REM_MAGIC_LINK_ONBOARDING?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export interface MagicLink {
  url: string;
  token: string;
  expiresAt: Date;
}

/**
 * Generate a magic link for a phone number.
 * Creates a cryptographically random token with 15-minute TTL.
 */
export async function generateMagicLink(phoneNumber: string, chatId: string): Promise<MagicLink> {
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const token = crypto.randomBytes(32).toString('base64url');
  const authToken = await createAuthToken(phoneNumber, chatId, token, MAGIC_LINK_TTL_MINUTES);

  const url = `${baseUrl}/auth/setup?token=${token}`;

  console.log(`[auth] Generated magic link for ${redactPhone(phoneNumber)}`);
  return { url, token, expiresAt: authToken.expiresAt };
}

/**
 * Verify a magic link token. Returns the phone number if valid, null otherwise.
 * Burns the token on successful verification.
 */
export async function verifyMagicLinkToken(token: string): Promise<string | null> {
  const phoneNumber = await verifyAuthToken(token);
  if (!phoneNumber) return null;
  await markAuthTokenUsed(token);
  return phoneNumber;
}

/**
 * Build the iMessage text the agent sends to onboard a new user.
 */
export function buildOnboardingMessage(magicLink: MagicLink): string {
  return `Before I can search or book, I need to link your reservation partner account — one quick step.
---
Tap below, sign in if asked, then paste your partner token on that page (from the browser Network tab on resy.com — same as texting it here, just easier on a full screen).
---
${magicLink.url}`;
}

/**
 * Send magic-link onboarding as separate bubbles (---). Returns false if link generation failed (caller may fall back to SMS OTP).
 */
export async function deliverMagicLinkOnboarding(
  chatId: string,
  phoneNumber: string,
  sendBubble: (text: string) => Promise<unknown>,
): Promise<boolean> {
  try {
    const link = await generateMagicLink(phoneNumber, chatId);
    const raw = buildOnboardingMessage(link);
    const parts = raw.split(/\s*---\s*/).map(p => p.trim()).filter(p => p.length > 0);
    for (let i = 0; i < parts.length; i++) {
      await sendBubble(parts[i]);
      if (i < parts.length - 1) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 400));
      }
    }
    return true;
  } catch (err) {
    console.error(`[auth] deliverMagicLinkOnboarding failed for ${redactPhone(phoneNumber)}:`, err);
    return false;
  }
}
