import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVerifyPaymentStatus = vi.fn();
const mockRecordPaymentSnapshotTransition = vi.fn();
const mockIsCloudBrowserReady = vi.fn();
const mockRunPaymentHandoff = vi.fn();
const mockMakeLivePaymentHandoffDeps = vi.fn(() => ({}));
const mockMakeLiveSmsBridge = vi.fn(() => ({}));
const mockSetPendingCloudBrowserOtp = vi.fn();

vi.mock('../../bookings/client.js', () => ({
  verifyPaymentStatus: (...args: unknown[]) => mockVerifyPaymentStatus(...args),
  recordPaymentSnapshotTransition: (...args: unknown[]) => mockRecordPaymentSnapshotTransition(...args),
}));

vi.mock('../../cloudBrowser/index.js', () => ({
  isCloudBrowserReady: () => mockIsCloudBrowserReady(),
  runPaymentHandoff: (...args: unknown[]) => mockRunPaymentHandoff(...args),
  makeLivePaymentHandoffDeps: () => mockMakeLivePaymentHandoffDeps(),
  makeLiveSmsBridge: () => mockMakeLiveSmsBridge(),
}));

vi.mock('../../auth/db.js', async (orig) => {
  const actual = await orig<typeof import('../../auth/db.js')>();
  return {
    ...actual,
    setPendingCloudBrowserOtp: (...args: unknown[]) => mockSetPendingCloudBrowserOtp(...args),
  };
});

import { afterResyCredentialsLinked } from '../../auth/afterResyLink.js';

beforeEach(() => {
  mockVerifyPaymentStatus.mockReset();
  mockRecordPaymentSnapshotTransition.mockReset();
  mockIsCloudBrowserReady.mockReset().mockReturnValue(false);
  mockRunPaymentHandoff.mockReset();
  mockSetPendingCloudBrowserOtp.mockReset();
  vi.stubEnv('PAYMENT_SETUP_URL', '');
});

describe('afterResyCredentialsLinked', () => {
  it('sends payment guidance when guest has no card on file (flag OFF)', async () => {
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
    expect(mockRunPaymentHandoff).not.toHaveBeenCalled();
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
    expect(mockRunPaymentHandoff).not.toHaveBeenCalled();
  });

  it('flag ON + handoff succeeds: sends live-view URL (not resy.com/login)', async () => {
    mockVerifyPaymentStatus.mockResolvedValue({
      hasPaymentMethod: false,
      defaultPaymentMethodId: null,
      fingerprint: '',
    });
    mockIsCloudBrowserReady.mockReturnValue(true);
    mockRunPaymentHandoff.mockResolvedValue({
      liveViewUrl: 'https://live.browserbase.com/sess_abc',
      sessionId: 'sess_abc',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      authPath: 'cookie',
    });

    const sent: string[] = [];
    await afterResyCredentialsLinked({
      phoneNumber: '+1999',
      chatId: 'chat_x',
      resyAuthToken: 'tok',
      sendMessage: async (_c, text) => { sent.push(text); },
    });

    expect(sent.length).toBe(2);
    expect(sent[0]).toContain("We're close");
    expect(sent[1]).toContain('https://live.browserbase.com/sess_abc');
    expect(sent[1]).not.toContain('resy.com/login');
    expect(mockRunPaymentHandoff).toHaveBeenCalledTimes(1);
    expect(mockSetPendingCloudBrowserOtp).not.toHaveBeenCalled();
  });

  it('flag ON + OTP auth path: registers pending cloud-browser OTP so next code routes there', async () => {
    mockVerifyPaymentStatus.mockResolvedValue({
      hasPaymentMethod: false,
      defaultPaymentMethodId: null,
      fingerprint: '',
    });
    mockIsCloudBrowserReady.mockReturnValue(true);
    mockRunPaymentHandoff.mockResolvedValue({
      liveViewUrl: 'https://live.browserbase.com/sess_otp',
      sessionId: 'sess_otp',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      authPath: 'otp',
    });

    await afterResyCredentialsLinked({
      phoneNumber: '+1999',
      chatId: 'chat_x',
      resyAuthToken: 'tok',
      sendMessage: async () => {},
    });

    expect(mockSetPendingCloudBrowserOtp).toHaveBeenCalledWith('+1999', 'sess_otp');
  });

  it('flag ON + handoff returns null: falls back to paymentFrontDesk URL', async () => {
    mockVerifyPaymentStatus.mockResolvedValue({
      hasPaymentMethod: false,
      defaultPaymentMethodId: null,
      fingerprint: '',
    });
    mockIsCloudBrowserReady.mockReturnValue(true);
    mockRunPaymentHandoff.mockResolvedValue(null);

    const sent: string[] = [];
    await afterResyCredentialsLinked({
      phoneNumber: '+1999',
      chatId: 'chat_x',
      resyAuthToken: 'tok',
      sendMessage: async (_c, text) => { sent.push(text); },
    });

    expect(sent.length).toBe(2);
    expect(sent[1]).toContain('https://resy.com/login');
    expect(mockRunPaymentHandoff).toHaveBeenCalledTimes(1);
  });

  it('flag ON + handoff throws: falls back to paymentFrontDesk URL', async () => {
    mockVerifyPaymentStatus.mockResolvedValue({
      hasPaymentMethod: false,
      defaultPaymentMethodId: null,
      fingerprint: '',
    });
    mockIsCloudBrowserReady.mockReturnValue(true);
    mockRunPaymentHandoff.mockRejectedValue(new Error('browserbase down'));

    const sent: string[] = [];
    await afterResyCredentialsLinked({
      phoneNumber: '+1999',
      chatId: 'chat_x',
      resyAuthToken: 'tok',
      sendMessage: async (_c, text) => { sent.push(text); },
    });

    expect(sent.length).toBe(2);
    expect(sent[1]).toContain('https://resy.com/login');
  });
});
