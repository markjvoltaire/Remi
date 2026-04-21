import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVerifyPaymentStatus = vi.fn();
const mockRecordPaymentSnapshotTransition = vi.fn();

vi.mock('../../bookings/client.js', () => ({
  verifyPaymentStatus: (...args: unknown[]) => mockVerifyPaymentStatus(...args),
  recordPaymentSnapshotTransition: (...args: unknown[]) => mockRecordPaymentSnapshotTransition(...args),
}));

import { afterResyCredentialsLinked } from '../../auth/afterResyLink.js';

beforeEach(() => {
  mockVerifyPaymentStatus.mockReset();
  mockRecordPaymentSnapshotTransition.mockReset();
  vi.stubEnv('PAYMENT_SETUP_URL', '');
});

describe('afterResyCredentialsLinked', () => {
  it('sends payment guidance when guest has no card on file', async () => {
    mockVerifyPaymentStatus.mockResolvedValue({
      hasPaymentMethod: false,
      defaultPaymentMethodId: null,
      fingerprint: '',
    });

    const sent: string[] = [];
    await afterResyCredentialsLinked({
      phoneNumber: '+1999',
      chatId: 'chat_x',
      resyAuthToken: 'tok',
      sendMessage: async (_c, text) => { sent.push(text); },
    });

    expect(mockRecordPaymentSnapshotTransition).toHaveBeenCalled();
    expect(sent.length).toBe(2);
    expect(sent[0]).toContain("We're close");
    expect(sent[1]).toContain('https://resy.com/login');
    expect(sent[1]).toContain('only do this once');
  });

  it('does not send extra messages when a card exists', async () => {
    mockVerifyPaymentStatus.mockResolvedValue({
      hasPaymentMethod: true,
      defaultPaymentMethodId: 1,
      fingerprint: '1',
    });

    const sent: string[] = [];
    await afterResyCredentialsLinked({
      phoneNumber: '+1999',
      chatId: 'chat_x',
      resyAuthToken: 'tok',
      sendMessage: async (_c, text) => { sent.push(text); },
    });

    expect(sent.length).toBe(0);
  });
});
