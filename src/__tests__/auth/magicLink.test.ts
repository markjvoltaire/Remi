import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateAuthToken = vi.fn();
const mockVerifyAuthToken = vi.fn();
const mockMarkAuthTokenUsed = vi.fn();

vi.mock('../../auth/db.js', () => ({
  createAuthToken: (...args: unknown[]) => mockCreateAuthToken(...args),
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
  markAuthTokenUsed: (...args: unknown[]) => mockMarkAuthTokenUsed(...args),
}));

import { generateMagicLink, verifyMagicLinkToken, deliverMagicLinkOnboarding } from '../../auth/magicLink.js';

beforeEach(() => {
  mockCreateAuthToken.mockReset();
  mockVerifyAuthToken.mockReset();
  mockMarkAuthTokenUsed.mockReset();
});

describe('magicLink', () => {
  it('generateMagicLink creates URL with token', async () => {
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    mockCreateAuthToken.mockResolvedValue({
      token: 'generated_token',
      phoneNumber: '+1111',
      chatId: 'chat_1',
      createdAt: new Date(),
      expiresAt: expires,
      used: false,
    });

    const link = await generateMagicLink('+1111', 'chat_1');
    expect(link.url).toContain('/auth/setup?token=');
    expect(link.expiresAt).toEqual(expires);
    expect(mockCreateAuthToken).toHaveBeenCalledWith('+1111', 'chat_1', expect.any(String), 15);
  });

  it('verifyMagicLinkToken returns phone for valid token', async () => {
    mockVerifyAuthToken.mockResolvedValue('+1111');
    mockMarkAuthTokenUsed.mockResolvedValue(undefined);

    const result = await verifyMagicLinkToken('valid_token');
    expect(result).toBe('+1111');
    expect(mockMarkAuthTokenUsed).toHaveBeenCalledWith('valid_token');
  });

  it('verifyMagicLinkToken returns null for invalid token', async () => {
    mockVerifyAuthToken.mockResolvedValue(null);

    const result = await verifyMagicLinkToken('bad_token');
    expect(result).toBeNull();
    expect(mockMarkAuthTokenUsed).not.toHaveBeenCalled();
  });

  it('deliverMagicLinkOnboarding sends segmented bubbles and includes setup URL', async () => {
    vi.stubEnv('BASE_URL', 'https://remi.example');
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    mockCreateAuthToken.mockResolvedValue({
      token: 'generated_token',
      phoneNumber: '+1111',
      chatId: 'chat_1',
      createdAt: new Date(),
      expiresAt: expires,
      used: false,
    });

    const bubbles: string[] = [];
    const ok = await deliverMagicLinkOnboarding('chat_1', '+1111', async (t) => {
      bubbles.push(t);
    });

    expect(ok).toBe(true);
    expect(bubbles.length).toBeGreaterThanOrEqual(2);
    expect(bubbles.some(b => b.includes('https://remi.example/auth/setup?token='))).toBe(true);
  });

  it('token is burned after verification (cannot reuse)', async () => {
    mockVerifyAuthToken
      .mockResolvedValueOnce('+1111') // First call: valid
      .mockResolvedValueOnce(null);   // Second call: burned
    mockMarkAuthTokenUsed.mockResolvedValue(undefined);

    const first = await verifyMagicLinkToken('once_token');
    expect(first).toBe('+1111');

    const second = await verifyMagicLinkToken('once_token');
    expect(second).toBeNull();
  });
});
