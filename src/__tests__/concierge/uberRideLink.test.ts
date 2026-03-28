import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildUberRideDeepLink } from '../../concierge/uberRideLink.js';

describe('buildUberRideDeepLink', () => {
  beforeEach(() => {
    vi.stubEnv('UBER_CLIENT_ID', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to setPickup and my_location when only dropoff is set', () => {
    const url = buildUberRideDeepLink({
      dropoffFormattedAddress: 'Carbone, 181 Thompson St, New York, NY',
    });
    expect(url).toMatch(/^https:\/\/m\.uber\.com\/ul\/\?/);
    const u = new URL(url);
    expect(u.searchParams.get('action')).toBe('setPickup');
    expect(u.searchParams.get('pickup')).toBe('my_location');
    expect(u.searchParams.get('dropoff[formatted_address]')).toBe('Carbone, 181 Thompson St, New York, NY');
  });

  it('includes client_id when UBER_CLIENT_ID is set', () => {
    vi.stubEnv('UBER_CLIENT_ID', 'abc_client');
    const url = buildUberRideDeepLink({ dropoffNickname: 'The Grill' });
    const u = new URL(url);
    expect(u.searchParams.get('client_id')).toBe('abc_client');
    expect(u.searchParams.get('dropoff[nickname]')).toBe('The Grill');
  });
});
