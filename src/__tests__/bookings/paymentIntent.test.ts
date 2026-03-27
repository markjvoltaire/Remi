import { describe, it, expect } from 'vitest';
import { messageSuggestsBookingIntent, recordPaymentSnapshotTransition } from '../../bookings/client.js';

describe('messageSuggestsBookingIntent', () => {
  it('matches booking-related phrasing', () => {
    expect(messageSuggestsBookingIntent('book us a table at Carbone tomorrow')).toBe(true);
    expect(messageSuggestsBookingIntent('reservation for 2 at 8pm')).toBe(true);
  });

  it('matches short confirmations after payment link', () => {
    expect(messageSuggestsBookingIntent('done')).toBe(true);
    expect(messageSuggestsBookingIntent('ok')).toBe(true);
  });

  it('ignores empty and off-topic small talk', () => {
    expect(messageSuggestsBookingIntent('')).toBe(false);
    expect(messageSuggestsBookingIntent('   ')).toBe(false);
    expect(messageSuggestsBookingIntent('thanks!')).toBe(false);
  });
});

describe('recordPaymentSnapshotTransition', () => {
  it('detects transition from no card to card', () => {
    const phone = '+199977766010';
    recordPaymentSnapshotTransition(phone, {
      hasPaymentMethod: false,
      defaultPaymentMethodId: null,
      fingerprint: '',
    });
    const second = recordPaymentSnapshotTransition(phone, {
      hasPaymentMethod: true,
      defaultPaymentMethodId: 42,
      fingerprint: '42',
    });
    expect(second.paymentBecameAvailable).toBe(true);
  });

  it('does not flag when card was already present', () => {
    const phone = '+199977766011';
    recordPaymentSnapshotTransition(phone, {
      hasPaymentMethod: true,
      defaultPaymentMethodId: 1,
      fingerprint: '1',
    });
    const again = recordPaymentSnapshotTransition(phone, {
      hasPaymentMethod: true,
      defaultPaymentMethodId: 1,
      fingerprint: '1',
    });
    expect(again.paymentBecameAvailable).toBe(false);
  });
});
