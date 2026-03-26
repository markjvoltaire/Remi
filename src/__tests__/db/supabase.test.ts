import { describe, it, expect, vi, beforeEach } from 'vitest';

let tokenExpiresAt: string;

vi.mock('@supabase/supabase-js', () => {
  return {
    createClient: () => {
      return {
        from: () => {
          return {
            select: () => {
              return {
                eq: () => {
                  return {
                    single: async () => {
                      return {
                        data: {
                          token: 'tok_exp',
                          phone_number: '+14155551234',
                          chat_id: 'chat_1',
                          created_at: new Date('2020-01-01T00:00:00.000Z').toISOString(),
                          expires_at: tokenExpiresAt,
                          used: false,
                        },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
});

describe('supabase storage TTL emulation', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    tokenExpiresAt = new Date(Date.now() + 60_000).toISOString();
  });

  it('returns null when an auth token is expired', async () => {
    tokenExpiresAt = new Date(Date.now() - 60_000).toISOString();
    const { getItem } = await import('../../db/supabase.js');
    const result = await getItem('AUTHTOKEN#tok_exp', 'AUTHTOKEN');
    expect(result).toBeNull();
  });

  it('returns the auth token data when not expired', async () => {
    tokenExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const { getItem } = await import('../../db/supabase.js');
    const result = await getItem<{
      phoneNumber: string;
      chatId: string;
      expiresAt: string;
      used: boolean;
    }>('AUTHTOKEN#tok_exp', 'AUTHTOKEN');

    expect(result).not.toBeNull();
    expect(result!.phoneNumber).toBe('+14155551234');
    expect(result!.chatId).toBe('chat_1');
    expect(result!.used).toBe(false);
  });
});

