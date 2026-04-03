import type { User, BookingsCredentials } from './types.js';
import { getUser, getCredentials, updateLastActive, createUser } from './db.js';
import { redactPhone } from '../utils/redact.js';

export interface UserContext {
  user: User;
  bookingsCredentials: BookingsCredentials;
  /** True when using the house/shared Resy account instead of the user's own linked account. */
  isHouseAccount: boolean;
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
 * 2. Env-level RESY_AUTH_TOKEN — same JWT for every sender (not tied to SMS number). Dev/demo;
 *    leave empty in production if each guest must use their own Resy.
 * 3. null → cannot book until personal credentials or house token is configured
 */
export async function loadUserContext(phoneNumber: string): Promise<UserContext | null> {
  let user = await getUser(phoneNumber);

  // Per-user credentials take priority
  if (user) {
    const creds = await getCredentials(phoneNumber);
    if (creds) {
      await updateLastActive(phoneNumber);
      return { user, bookingsCredentials: creds, isHouseAccount: false };
    }
  }

  const envResyAuthToken = getEnvResyAuthToken();

  // Fallback: shared house token for any phone (sign-out only clears stored creds, not this path)
  if (envResyAuthToken) {
    if (!user) {
      user = await createUser(phoneNumber);
    }
    await updateLastActive(phoneNumber);
    console.log(
      `[auth] house account · guest=${redactPhone(phoneNumber)} · booking via shared Resy token`,
    );
    return {
      user,
      bookingsCredentials: { resyAuthToken: envResyAuthToken },
      isHouseAccount: true,
    };
  }

  return null;
}
