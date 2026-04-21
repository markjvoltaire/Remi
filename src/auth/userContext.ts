import type { User, BookingsCredentials } from './types.js';
import { getUser, getCredentials, updateLastActive, createUser, isSignedOut } from './db.js';
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
 * 1. Per-user encrypted credentials (from onboarding) — each guest books with their own Resy session
 * 2. Env-level `RESY_AUTH_TOKEN` when set — fallback for users who have not linked yet (`isHouseAccount: true`)
 * 3. `null` → triggers onboarding flow
 */
export async function loadUserContext(phoneNumber: string): Promise<UserContext | null> {
  let user = await getUser(phoneNumber);

  if (user) {
    const creds = await getCredentials(phoneNumber);
    if (creds) {
      await updateLastActive(phoneNumber);
      return { user, bookingsCredentials: creds, isHouseAccount: false };
    }
  }

  const envResyAuthToken = getEnvResyAuthToken();

  if (envResyAuthToken && !(await isSignedOut(phoneNumber))) {
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
