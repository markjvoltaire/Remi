import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();
const mockGetCredentials = vi.fn();
const mockUpdateLastActive = vi.fn();
const mockCreateUser = vi.fn();
const mockIsSignedOut = vi.fn();

vi.mock('../../auth/db.js', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getCredentials: (...args: unknown[]) => mockGetCredentials(...args),
  updateLastActive: (...args: unknown[]) => mockUpdateLastActive(...args),
  createUser: (...args: unknown[]) => mockCreateUser(...args),
  isSignedOut: (...args: unknown[]) => mockIsSignedOut(...args),
}));

beforeEach(() => {
  vi.stubEnv('RESY_AUTH_TOKEN', '');
  vi.stubEnv('RESY_USE_SHARED_TOKEN', '');
  mockGetUser.mockReset();
  mockGetCredentials.mockReset();
  mockUpdateLastActive.mockReset();
  mockCreateUser.mockReset();
  mockIsSignedOut.mockReset();
});

// Must import after mocks are set up.

describe('loadUserContext', () => {
  it('returns user + credentials when both exist', async () => {
    const user = { phoneNumber: '+1111', createdAt: new Date(), lastActive: new Date(), onboardingComplete: true };
    const creds = { resyAuthToken: 'tok_123' };
    mockGetUser.mockResolvedValue(user);
    mockGetCredentials.mockResolvedValue(creds);
    mockUpdateLastActive.mockResolvedValue(undefined);

    const { loadUserContext } = await import('../../auth/userContext.js');
    const ctx = await loadUserContext('+1111');
    expect(ctx).not.toBeNull();
    expect(ctx!.user).toEqual(user);
    expect(ctx!.bookingsCredentials).toEqual(creds);
    expect(ctx!.isHouseAccount).toBe(false);
    expect(mockUpdateLastActive).toHaveBeenCalledWith('+1111');
  });

  it('prefers stored credentials over RESY_AUTH_TOKEN when both are set', async () => {
    vi.stubEnv('RESY_AUTH_TOKEN', 'env_tok');
    const user = { phoneNumber: '+6666', createdAt: new Date(), lastActive: new Date(), onboardingComplete: true };
    mockGetUser.mockResolvedValue(user);
    mockGetCredentials.mockResolvedValue({ resyAuthToken: 'stored_tok' });
    mockIsSignedOut.mockResolvedValue(false);
    mockUpdateLastActive.mockResolvedValue(undefined);

    const { loadUserContext } = await import('../../auth/userContext.js');
    const ctx = await loadUserContext('+6666');
    expect(ctx).not.toBeNull();
    expect(ctx!.bookingsCredentials.resyAuthToken).toBe('stored_tok');
    expect(ctx!.isHouseAccount).toBe(false);
    expect(mockGetCredentials).toHaveBeenCalledWith('+6666');
    expect(mockUpdateLastActive).toHaveBeenCalledWith('+6666');
  });

  it('returns null when no user and no env token', async () => {
    mockGetUser.mockResolvedValue(null);
    mockIsSignedOut.mockResolvedValue(false);

    const { loadUserContext } = await import('../../auth/userContext.js');
    const ctx = await loadUserContext('+2222');
    expect(ctx).toBeNull();
  });

  it('returns null when user exists but has no credentials and RESY_AUTH_TOKEN is unset', async () => {
    const user = { phoneNumber: '+7777', createdAt: new Date(), lastActive: new Date(), onboardingComplete: false };
    mockGetUser.mockResolvedValue(user);
    mockGetCredentials.mockResolvedValue(null);

    const { loadUserContext } = await import('../../auth/userContext.js');
    const ctx = await loadUserContext('+7777');
    expect(ctx).toBeNull();
    expect(mockUpdateLastActive).not.toHaveBeenCalled();
  });

  it('falls back to RESY_AUTH_TOKEN when set (no extra flag required)', async () => {
    vi.stubEnv('RESY_AUTH_TOKEN', 'env_tok_fallback');
    vi.stubEnv('RESY_USE_SHARED_TOKEN', '');
    vi.resetModules();

    // Re-mock after resetModules
    vi.doMock('../../auth/db.js', () => ({
      getUser: mockGetUser,
      getCredentials: mockGetCredentials,
      updateLastActive: mockUpdateLastActive,
      createUser: mockCreateUser,
      isSignedOut: mockIsSignedOut,
    }));

    const user = { phoneNumber: '+3333', createdAt: new Date(), lastActive: new Date(), onboardingComplete: false };
    mockGetUser.mockResolvedValue(user);
    mockGetCredentials.mockResolvedValue(null); // No per-user creds
    mockIsSignedOut.mockResolvedValue(false);
    mockUpdateLastActive.mockResolvedValue(undefined);

    const { loadUserContext } = await import('../../auth/userContext.js');
    const ctx = await loadUserContext('+3333');
    expect(ctx).not.toBeNull();
    expect(ctx!.bookingsCredentials.resyAuthToken).toBe('env_tok_fallback');
    expect(ctx!.isHouseAccount).toBe(true);
  });

  it('returns null when user signed out (even with env token)', async () => {
    vi.stubEnv('RESY_AUTH_TOKEN', 'env_tok_present');
    vi.resetModules();

    vi.doMock('../../auth/db.js', () => ({
      getUser: mockGetUser,
      getCredentials: mockGetCredentials,
      updateLastActive: mockUpdateLastActive,
      createUser: mockCreateUser,
      isSignedOut: mockIsSignedOut,
    }));

    const user = { phoneNumber: '+4444', createdAt: new Date(), lastActive: new Date(), onboardingComplete: false };
    mockGetUser.mockResolvedValue(user);
    mockGetCredentials.mockResolvedValue(null);
    mockIsSignedOut.mockResolvedValue(true); // Signed out!

    const { loadUserContext } = await import('../../auth/userContext.js');
    const ctx = await loadUserContext('+4444');
    expect(ctx).toBeNull();
  });

  it('creates user when env token exists but no user record', async () => {
    vi.stubEnv('RESY_AUTH_TOKEN', 'env_tok_create');
    vi.resetModules();

    vi.doMock('../../auth/db.js', () => ({
      getUser: mockGetUser,
      getCredentials: mockGetCredentials,
      updateLastActive: mockUpdateLastActive,
      createUser: mockCreateUser,
      isSignedOut: mockIsSignedOut,
    }));

    const newUser = { phoneNumber: '+5555', createdAt: new Date(), lastActive: new Date(), onboardingComplete: false };
    mockGetUser.mockResolvedValue(null); // No user
    mockGetCredentials.mockResolvedValue(null);
    mockIsSignedOut.mockResolvedValue(false);
    mockCreateUser.mockResolvedValue(newUser);
    mockUpdateLastActive.mockResolvedValue(undefined);

    const { loadUserContext } = await import('../../auth/userContext.js');
    const ctx = await loadUserContext('+5555');
    expect(ctx).not.toBeNull();
    expect(mockCreateUser).toHaveBeenCalledWith('+5555');
    expect(ctx!.bookingsCredentials.resyAuthToken).toBe('env_tok_create');
    expect(ctx!.isHouseAccount).toBe(true);
  });
});

describe('isResySharedTokenMode', () => {
  it('returns false when RESY_AUTH_TOKEN is missing or blank', async () => {
    vi.stubEnv('RESY_AUTH_TOKEN', '');
    const { isResySharedTokenMode } = await import('../../auth/userContext.js');
    expect(isResySharedTokenMode()).toBe(false);
    vi.stubEnv('RESY_AUTH_TOKEN', '   ');
    expect(isResySharedTokenMode()).toBe(false);
  });

  it('returns true when RESY_AUTH_TOKEN is non-empty', async () => {
    vi.stubEnv('RESY_AUTH_TOKEN', 'house_jwt');
    const { isResySharedTokenMode } = await import('../../auth/userContext.js');
    expect(isResySharedTokenMode()).toBe(true);
  });
});
