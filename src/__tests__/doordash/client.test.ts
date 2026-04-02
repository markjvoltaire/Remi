import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createDelivery, DoorDashApiError, isDoorDashConfigured } from '../../doordash/client.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubEnv('DOORDASH_ENABLED', 'true');
  vi.stubEnv('DOORDASH_DEVELOPER_ID', 'test_developer_id');
  vi.stubEnv('DOORDASH_KEY_ID', 'test_key_id');
  vi.stubEnv('DOORDASH_SIGNING_SECRET', Buffer.from('x'.repeat(32)).toString('base64'));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

const minimalBody = {
  external_delivery_id: 'D-remi-test',
  pickup_address: '901 Market St, San Francisco, CA 94103',
  pickup_business_name: 'Pickup Biz',
  pickup_phone_number: '+14155550100',
  dropoff_address: '902 Market St, San Francisco, CA 94103',
  dropoff_business_name: 'Dropoff Biz',
  dropoff_phone_number: '+14155550101',
  order_value: 1999,
};

describe('isDoorDashConfigured', () => {
  it('returns false when DOORDASH_ENABLED is not truthy', () => {
    vi.unstubAllEnvs();
    vi.stubEnv('DOORDASH_DEVELOPER_ID', 'a');
    vi.stubEnv('DOORDASH_KEY_ID', 'b');
    vi.stubEnv('DOORDASH_SIGNING_SECRET', 'YQ==');
    expect(isDoorDashConfigured()).toBe(false);
  });

  it('returns true when enabled and all secrets set', () => {
    expect(isDoorDashConfigured()).toBe(true);
  });

  it('accepts DOORDASH_ENABLE as alias when DOORDASH_ENABLED is unset', () => {
    vi.unstubAllEnvs();
    vi.stubEnv('DOORDASH_ENABLE', 'true');
    vi.stubEnv('DOORDASH_DEVELOPER_ID', 'a');
    vi.stubEnv('DOORDASH_KEY_ID', 'b');
    vi.stubEnv('DOORDASH_SIGNING_SECRET', 'YQ==');
    expect(isDoorDashConfigured()).toBe(true);
  });
});

describe('createDelivery', () => {
  it('POSTs JSON to Drive deliveries with Bearer auth', async () => {
    const mockPayload = { external_delivery_id: 'D-remi-test', delivery_status: 'created' };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(mockPayload),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createDelivery(minimalBody);

    expect(result.delivery_status).toBe('created');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/drive/v2/deliveries');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(minimalBody);
  });

  it('throws DoorDashApiError on non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: 'bad request' }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await createDelivery(minimalBody);
      expect.fail('expected DoorDashApiError');
    } catch (e) {
      expect(e).toBeInstanceOf(DoorDashApiError);
      expect((e as DoorDashApiError).status).toBe(400);
    }
  });
});
