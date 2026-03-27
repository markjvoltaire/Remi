import type { User, BookingsCredentials } from './types.js';
import { getUser, getCredentials, updateLastActive, createUser, isSignedOut } from './db.js';

export interface UserContext {
  user: User;
  bookingsCredentials: BookingsCredentials;
}

function getEnvResyAuthToken(): string {
  return process.env.RESY_AUTH_TOKEN?.trim() || '';
}

function useSharedResyToken(): boolean {
  const value = process.env.RESY_USE_SHARED_TOKEN?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Load a user's context (user record + decrypted credentials).
 *
 * Priority:
 * 1. Per-user encrypted credentials (from onboarding)
 * 2. Env-level RESY_AUTH_TOKEN fallback (only when RESY_USE_SHARED_TOKEN is enabled)
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

  // Fallback: env-level token (skip onboarding entirely)
  // But NOT if user explicitly signed out (they want to re-onboard)
  if (useSharedResyToken() && envResyAuthToken && !(await isSignedOut(phoneNumber))) {
    if (!user) {
      user = await createUser(phoneNumber);
    }
    await updateLastActive(phoneNumber);
    return {
      user,
      bookingsCredentials: { resyAuthToken: envResyAuthToken },
    };
  }

  return null;
}
