import { describe, it, expect } from 'vitest';
import { phonesMatch, phoneDigitsKey } from '../../utils/phoneMatch.js';

describe('phonesMatch', () => {
  it('matches +1 and 1 and 10-digit US forms', () => {
    expect(phonesMatch('+14155551234', '14155551234')).toBe(true);
    expect(phonesMatch('+14155551234', '4155551234')).toBe(true);
    expect(phonesMatch('4155551234', '+1 (415) 555-1234')).toBe(true);
  });

  it('does not match different numbers', () => {
    expect(phonesMatch('+14155551234', '+14155559999')).toBe(false);
  });

  it('phoneDigitsKey strips non-digits', () => {
    expect(phoneDigitsKey('+1 (415) 555-1234')).toBe('14155551234');
  });
});
