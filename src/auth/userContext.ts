import type { User, BookingsCredentials } from './types.js';
import { getUser, getCredentials, updateLastActive, createUser, isSignedOut } from './db.js';
import { redactPhone } from '../utils/redact.js';

export interface UserContext {
  user: User;
  bookingsCredentials: BookingsCredentials;
}

function getEnvResyAuthToken(): string {
  return process.env.RESY_AUTH_TOKEN?.trim() || '';
}

/** True when a shared master Resy JWT is configured (single-operator / demo mode). */
export function isResySharedTokenMode(): boolean {
  return Boolean(getEnvResyAuthToken());
}

/**
 * Load a user's context (user record + decrypted credentials).
 *
 * Priority:
 * 1. Per-user encrypted credentials (from onboarding)
 * 2. Env-level RESY_AUTH_TOKEN fallback (skip OTP when set — dev/demo only; leave empty in production)
 * 3. null → triggers onboarding flow
 */
export async function loadUserContext(phoneNumber: string): Promise<UserContext | null> {
  let user = await getUser(phoneNumber);

  // Per-user credentials take priority
  if (user) {
    const creds = await getCredentials(phoneNumber);
    if (creds) {
      await updateLastActive(phoneNumber);
      return { user, bookingsCredentials: creds };
    }
  }

  const envResyAuthToken = getEnvResyAuthToken();

  // Fallback: env-level token skips partner OTP — each guest still has their own user row + chat thread
  if (envResyAuthToken && !(await isSignedOut(phoneNumber))) {
    if (!user) {
      user = await createUser(phoneNumber);
    }
    await updateLastActive(phoneNumber);
    console.log(
      `[auth] shared Resy token · guest=${redactPhone(phoneNumber)} · conversation remains keyed by chatId (per thread)`,
    );
    return {
      user,
      bookingsCredentials: { resyAuthToken: envResyAuthToken },
    };
  }

  return null;
}
