import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type StorageSk =
  | 'PROFILE'
  | 'CREDENTIALS'
  | 'SIGNED_OUT'
  | 'JUST_ONBOARDED'
  | 'PROFILE_ONBOARDING'
  | 'PENDING_OTP'
  | 'PENDING_CHALLENGE'
  | 'AUTHTOKEN'
  | 'CONV'
  | 'USERPROFILE'
  | 'CHATCOUNT';

const EXPIRY_COLUMNS: Record<StorageSk, string | null> = {
  PROFILE: null,
  CREDENTIALS: null,
  SIGNED_OUT: null,
  JUST_ONBOARDED: 'expires_at',
  PROFILE_ONBOARDING: null,
  PENDING_OTP: 'expires_at',
  PENDING_CHALLENGE: 'expires_at',
  AUTHTOKEN: 'expires_at',
  CONV: 'expires_at',
  USERPROFILE: null,
  CHATCOUNT: 'expires_at',
};

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('[storage] Supabase not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }

  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

function toSnakeCase(input: string): string {
  return input.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function normalizeIso(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function normalizeBigint(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n;
}

function isExpired(expiresAt: unknown, now = new Date()): boolean {
  if (!expiresAt) return false;
  const dt = expiresAt instanceof Date ? expiresAt : new Date(String(expiresAt));
  return dt.getTime() <= now.getTime();
}

function entityFromPk(pk: string): { entity: 'user' | 'authToken' | 'conversation' | 'userProfile' | 'chatCount'; id: string } {
  if (pk.startsWith('USER#')) return { entity: 'user', id: pk.slice('USER#'.length) };
  if (pk.startsWith('AUTHTOKEN#')) return { entity: 'authToken', id: pk.slice('AUTHTOKEN#'.length) };
  if (pk.startsWith('CONV#')) return { entity: 'conversation', id: pk.slice('CONV#'.length) };
  if (pk.startsWith('USERPROFILE#')) return { entity: 'userProfile', id: pk.slice('USERPROFILE#'.length) };
  if (pk.startsWith('CHATCOUNT#')) return { entity: 'chatCount', id: pk.slice('CHATCOUNT#'.length) };
  throw new Error(`[storage] Unrecognized PK: ${pk}`);
}

function mapKeysToSnake(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    out[toSnakeCase(k)] = v;
  }
  return out;
}

export async function getItem<T>(pk: string, sk: string): Promise<T | null> {
  const client = getClient();
  const now = new Date();
  const parsed = entityFromPk(pk);
  const itemSk = sk as StorageSk;

  if (parsed.entity === 'user') {
    const phoneNumber = parsed.id;
    switch (itemSk) {
      case 'PROFILE': {
        const { data, error } = await client
          .from('agent_users')
          .select('phone_number,created_at,last_active,onboarding_complete')
          .eq('phone_number', phoneNumber)
          .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        if (!data) return null;

        return {
          phoneNumber: data.phone_number,
          createdAt: normalizeIso(data.created_at),
          lastActive: normalizeIso(data.last_active),
          onboardingComplete: data.onboarding_complete,
        } as T;
      }

      case 'CREDENTIALS': {
        const { data, error } = await client
          .from('agent_credentials')
          .select('encrypted')
          .eq('phone_number', phoneNumber)
          .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        if (!data) return null;
        return { encrypted: data.encrypted } as T;
      }

      case 'SIGNED_OUT': {
        const { data, error } = await client
          .from('agent_signed_out')
          .select('phone_number')
          .eq('phone_number', phoneNumber)
          .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        if (!data) return null;
        return {} as T;
      }

      case 'JUST_ONBOARDED': {
        const { data, error } = await client
          .from('agent_just_onboarded')
          .select('expires_at')
          .eq('phone_number', phoneNumber)
          .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        if (!data) return null;
        if (isExpired(data.expires_at, now)) return null;
        return {} as T;
      }

      case 'PROFILE_ONBOARDING': {
        const { data, error } = await client
          .from('agent_profile_onboarding')
          .select('stage,name,city,neighborhood,dietary,completed,updated_at')
          .eq('phone_number', phoneNumber)
          .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        if (!data) return null;
        return {
          stage: data.stage,
          name: data.name,
          city: data.city,
          neighborhood: data.neighborhood,
          dietary: data.dietary,
          completed: data.completed,
          updatedAt: normalizeIso(data.updated_at),
        } as T;
      }

      case 'PENDING_OTP': {
        const { data, error } = await client
          .from('agent_pending_otp')
          .select('chat_id,sent_at,expires_at')
          .eq('phone_number', phoneNumber)
          .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        if (!data) return null;
        if (isExpired(data.expires_at, now)) return null;
        return {
          chatId: data.chat_id,
          sentAt: normalizeIso(data.sent_at),
        } as T;
      }

      case 'PENDING_CHALLENGE': {
        const { data, error } = await client
          .from('agent_pending_challenges')
          .select(
            'chat_id,claim_token,challenge_id,mobile_number,first_name,is_new_user,required_fields,sent_at,expires_at',
          )
          .eq('phone_number', phoneNumber)
          .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        if (!data) return null;
        if (isExpired(data.expires_at, now)) return null;
        return {
          chatId: data.chat_id,
          claimToken: data.claim_token,
          challengeId: data.challenge_id,
          mobileNumber: data.mobile_number,
          firstName: data.first_name,
          isNewUser: data.is_new_user,
          requiredFields: data.required_fields,
          sentAt: normalizeIso(data.sent_at),
        } as T;
      }

      default:
        throw new Error(`[storage] Unsupported user SK: ${sk}`);
    }
  }

  if (parsed.entity === 'authToken') {
    const token = parsed.id;
    if (itemSk !== 'AUTHTOKEN') throw new Error(`[storage] Unsupported authToken SK: ${sk}`);

    const { data, error } = await client
      .from('agent_auth_tokens')
      .select('token,phone_number,chat_id,created_at,expires_at,used')
      .eq('token', token)
      .single();

    if (error && error.code === 'PGRST116') return null;
    if (error) throw error;
    if (!data) return null;
    if (isExpired(data.expires_at, now)) return null;

    return {
      token: data.token,
      phoneNumber: data.phone_number,
      chatId: data.chat_id,
      createdAt: normalizeIso(data.created_at),
      expiresAt: normalizeIso(data.expires_at),
      used: data.used,
    } as T;
  }

  if (parsed.entity === 'conversation') {
    const chatId = parsed.id;
    if (itemSk !== 'CONV') throw new Error(`[storage] Unsupported conversation SK: ${sk}`);

    const { data, error } = await client
      .from('agent_conversations')
      .select('chat_id,messages,last_active,expires_at')
      .eq('chat_id', chatId)
      .single();

    if (error && error.code === 'PGRST116') return null;
    if (error) throw error;
    if (!data) return null;
    if (isExpired(data.expires_at, now)) return null;

    return {
      messages: data.messages,
      lastActive: normalizeBigint(data.last_active),
    } as T;
  }

  if (parsed.entity === 'userProfile') {
    const handle = parsed.id;
    if (itemSk !== 'USERPROFILE') throw new Error(`[storage] Unsupported userProfile SK: ${sk}`);

    const { data, error } = await client
      .from('agent_user_profiles')
      .select('handle,name,facts,first_seen,last_seen')
      .eq('handle', handle)
      .single();

    if (error && error.code === 'PGRST116') return null;
    if (error) throw error;
    if (!data) return null;

    return {
      handle: data.handle,
      name: data.name,
      facts: data.facts,
      firstSeen: normalizeBigint(data.first_seen),
      lastSeen: normalizeBigint(data.last_seen),
    } as T;
  }

  if (parsed.entity === 'chatCount') {
    const chatId = parsed.id;
    if (itemSk !== 'CHATCOUNT') throw new Error(`[storage] Unsupported chatCount SK: ${sk}`);

    const { data, error } = await client
      .from('agent_chat_counts')
      .select('chat_id,count,expires_at')
      .eq('chat_id', chatId)
      .single();

    if (error && error.code === 'PGRST116') return null;
    if (error) throw error;
    if (!data) return null;
    if (isExpired(data.expires_at, now)) return null;

    return { count: normalizeBigint(data.count) } as T;
  }

  throw new Error(`[storage] Unhandled getItem case: pk=${pk} sk=${sk}`);
}

export async function putItem(
  pk: string,
  sk: string,
  data: Record<string, unknown>,
  ttlSeconds?: number,
): Promise<void> {
  const client = getClient();
  const parsed = entityFromPk(pk);
  const itemSk = sk as StorageSk;

  const ttlExpiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;

  const upsert = async (table: string, row: Record<string, unknown>, onConflict: string) => {
    await client.from(table).upsert(row, { onConflict });
  };

  if (parsed.entity === 'user') {
    const phoneNumber = parsed.id;
    switch (itemSk) {
      case 'PROFILE': {
        const row = mapKeysToSnake({ ...data, phoneNumber });
        await upsert('agent_users', row, 'phone_number');
        return;
      }
      case 'CREDENTIALS': {
        const row = mapKeysToSnake({ ...data, phoneNumber });
        await upsert('agent_credentials', row, 'phone_number');
        return;
      }
      case 'SIGNED_OUT': {
        await upsert('agent_signed_out', { phone_number: phoneNumber }, 'phone_number');
        return;
      }
      case 'JUST_ONBOARDED': {
        await upsert(
          'agent_just_onboarded',
          { phone_number: phoneNumber, expires_at: ttlExpiresAt ?? new Date(Date.now() + 10 * 60 * 1000) },
          'phone_number',
        );
        return;
      }
      case 'PROFILE_ONBOARDING': {
        const row = mapKeysToSnake({ ...data, phoneNumber });
        await upsert('agent_profile_onboarding', row, 'phone_number');
        return;
      }
      case 'PENDING_OTP': {
        const row = mapKeysToSnake({ ...data, phoneNumber });
        if (ttlExpiresAt) row.expires_at = ttlExpiresAt;
        await upsert('agent_pending_otp', row, 'phone_number');
        return;
      }
      case 'PENDING_CHALLENGE': {
        const row = mapKeysToSnake({ ...data, phoneNumber });
        if (ttlExpiresAt) row.expires_at = ttlExpiresAt;
        await upsert('agent_pending_challenges', row, 'phone_number');
        return;
      }
      default:
        throw new Error(`[storage] Unsupported user SK for putItem: ${sk}`);
    }
  }

  if (parsed.entity === 'authToken') {
    const token = parsed.id;
    if (itemSk !== 'AUTHTOKEN') throw new Error(`[storage] Unsupported authToken SK for putItem: ${sk}`);

    const mapped = mapKeysToSnake({ ...data, token });
    if (!('expires_at' in mapped) && ttlExpiresAt) mapped.expires_at = ttlExpiresAt;
    await upsert('agent_auth_tokens', mapped, 'token');
    return;
  }

  if (parsed.entity === 'conversation') {
    const chatId = parsed.id;
    if (itemSk !== 'CONV') throw new Error(`[storage] Unsupported conversation SK for putItem: ${sk}`);

    const mapped = mapKeysToSnake({ ...data, chatId });
    if (ttlExpiresAt) mapped.expires_at = ttlExpiresAt;
    await upsert('agent_conversations', mapped, 'chat_id');
    return;
  }

  if (parsed.entity === 'userProfile') {
    const handle = parsed.id;
    if (itemSk !== 'USERPROFILE') throw new Error(`[storage] Unsupported userProfile SK for putItem: ${sk}`);

    const mapped = mapKeysToSnake({ ...data, handle });
    await upsert('agent_user_profiles', mapped, 'handle');
    return;
  }

  if (parsed.entity === 'chatCount') {
    const chatId = parsed.id;
    if (itemSk !== 'CHATCOUNT') throw new Error(`[storage] Unsupported chatCount SK for putItem: ${sk}`);

    const mapped = mapKeysToSnake({ ...data, chatId });
    if (ttlExpiresAt) mapped.expires_at = ttlExpiresAt;
    await upsert('agent_chat_counts', mapped, 'chat_id');
    return;
  }

  throw new Error(`[storage] Unhandled putItem case: pk=${pk} sk=${sk}`);
}

export async function deleteItem(pk: string, sk: string): Promise<void> {
  const client = getClient();
  const parsed = entityFromPk(pk);
  const itemSk = sk as StorageSk;

  if (parsed.entity === 'user') {
    const phoneNumber = parsed.id;
    switch (itemSk) {
      case 'CREDENTIALS':
        await client.from('agent_credentials').delete().eq('phone_number', phoneNumber);
        return;
      case 'SIGNED_OUT':
        await client.from('agent_signed_out').delete().eq('phone_number', phoneNumber);
        return;
      case 'JUST_ONBOARDED':
        await client.from('agent_just_onboarded').delete().eq('phone_number', phoneNumber);
        return;
      case 'PROFILE_ONBOARDING':
        await client.from('agent_profile_onboarding').delete().eq('phone_number', phoneNumber);
        return;
      case 'PENDING_OTP':
        await client.from('agent_pending_otp').delete().eq('phone_number', phoneNumber);
        return;
      case 'PENDING_CHALLENGE':
        await client.from('agent_pending_challenges').delete().eq('phone_number', phoneNumber);
        return;
      case 'PROFILE':
        await client.from('agent_users').delete().eq('phone_number', phoneNumber);
        return;
      default:
        throw new Error(`[storage] Unsupported user SK for deleteItem: ${sk}`);
    }
  }

  if (parsed.entity === 'conversation') {
    const chatId = parsed.id;
    if (itemSk !== 'CONV') throw new Error(`[storage] Unsupported conversation SK for deleteItem: ${sk}`);
    await client.from('agent_conversations').delete().eq('chat_id', chatId);
    return;
  }

  if (parsed.entity === 'userProfile') {
    const handle = parsed.id;
    if (itemSk !== 'USERPROFILE') throw new Error(`[storage] Unsupported userProfile SK for deleteItem: ${sk}`);
    await client.from('agent_user_profiles').delete().eq('handle', handle);
    return;
  }

  if (parsed.entity === 'chatCount') {
    const chatId = parsed.id;
    if (itemSk !== 'CHATCOUNT') throw new Error(`[storage] Unsupported chatCount SK for deleteItem: ${sk}`);
    await client.from('agent_chat_counts').delete().eq('chat_id', chatId);
    return;
  }

  if (parsed.entity === 'authToken') {
    const token = parsed.id;
    if (itemSk !== 'AUTHTOKEN') throw new Error(`[storage] Unsupported authToken SK for deleteItem: ${sk}`);
    await client.from('agent_auth_tokens').delete().eq('token', token);
    return;
  }

  throw new Error(`[storage] Unhandled deleteItem case: pk=${pk} sk=${sk}`);
}

export async function updateItem(pk: string, sk: string, updates: Record<string, unknown>): Promise<void> {
  const client = getClient();
  const parsed = entityFromPk(pk);
  const itemSk = sk as StorageSk;

  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  const mappedUpdates = mapKeysToSnake(updates);

  if (parsed.entity === 'user') {
    const phoneNumber = parsed.id;
    if (itemSk !== 'PROFILE') throw new Error(`[storage] Unsupported user SK for updateItem: ${sk}`);
    await client.from('agent_users').update(mappedUpdates).eq('phone_number', phoneNumber);
    return;
  }

  if (parsed.entity === 'authToken') {
    const token = parsed.id;
    if (itemSk !== 'AUTHTOKEN') throw new Error(`[storage] Unsupported authToken SK for updateItem: ${sk}`);
    await client.from('agent_auth_tokens').update(mappedUpdates).eq('token', token);
    return;
  }

  throw new Error(`[storage] Unsupported updateItem for pk=${pk} sk=${sk}`);
}

export async function queryByPk<T>(pk: string): Promise<T[]> {
  // This is only lightly used (dashboard/tests). Implement by delegating to getItem.
  const items: T[] = [];
  const parsed = entityFromPk(pk);

  if (parsed.entity === 'user') {
    const phoneNumber = parsed.id;
    // Match the DynamoDB single-table design: multiple SK records can share the same PK.
    const mapping: Array<StorageSk> = ['PROFILE', 'CREDENTIALS', 'SIGNED_OUT', 'JUST_ONBOARDED', 'PROFILE_ONBOARDING', 'PENDING_OTP', 'PENDING_CHALLENGE'];
    for (const sk of mapping) {
      const v = await getItem<Record<string, unknown>>(pk, sk);
      if (v) items.push({ PK: `USER#${phoneNumber}`, SK: sk, ...(v as Record<string, unknown>) } as unknown as T);
    }
    return items;
  }

  if (parsed.entity === 'authToken') {
    const token = parsed.id;
    const v = await getItem<Record<string, unknown>>(pk, 'AUTHTOKEN');
    return v ? ([{ PK: `AUTHTOKEN#${token}`, SK: 'AUTHTOKEN', ...(v as Record<string, unknown>) }] as unknown as T[]) : [];
  }

  if (parsed.entity === 'conversation') {
    const chatId = parsed.id;
    const v = await getItem<Record<string, unknown>>(pk, 'CONV');
    return v ? ([{ PK: `CONV#${chatId}`, SK: 'CONV', ...(v as Record<string, unknown>) }] as unknown as T[]) : [];
  }

  if (parsed.entity === 'userProfile') {
    const handle = parsed.id;
    const v = await getItem<Record<string, unknown>>(pk, 'USERPROFILE');
    return v ? ([{ PK: `USERPROFILE#${handle}`, SK: 'USERPROFILE', ...(v as Record<string, unknown>) }] as unknown as T[]) : [];
  }

  if (parsed.entity === 'chatCount') {
    const chatId = parsed.id;
    const v = await getItem<Record<string, unknown>>(pk, 'CHATCOUNT');
    return v ? ([{ PK: `CHATCOUNT#${chatId}`, SK: 'CHATCOUNT', ...(v as Record<string, unknown>) }] as unknown as T[]) : [];
  }

  return [];
}

