import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSendResyOTP = vi.fn();
vi.mock('../../bookings/client.js', () => ({
  sendResyOTP: (...args: unknown[]) => mockSendResyOTP(...args),
}));

import {
  ingestOtpCode,
  clearOtpBridgeState,
  makeLiveSmsBridge,
} from '../../cloudBrowser/otpBridge.js';

beforeEach(() => {
  mockSendResyOTP.mockReset();
  clearOtpBridgeState('+14155551234');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ResyOtpSmsBridge', () => {
  it('waitForCode resolves when ingestOtpCode is called after subscription', async () => {
    const bridge = makeLiveSmsBridge();
    const pending = bridge.waitForCode('+14155551234');

    ingestOtpCode('+14155551234', '123456');

    await expect(pending).resolves.toBe('123456');
  });

  it('waitForCode returns an already-buffered code synchronously', async () => {
    const bridge = makeLiveSmsBridge();
    ingestOtpCode('+14155551234', '424242');

    await expect(bridge.waitForCode('+14155551234', 5_000)).resolves.toBe('424242');
  });

  it('waitForCode rejects with a timeout when no code arrives', async () => {
    vi.useFakeTimers();
    const bridge = makeLiveSmsBridge();

    const pending = bridge.waitForCode('+14155551234', 90_000);
    pending.catch(() => {}); // prevent unhandled rejection
    vi.advanceTimersByTime(90_001);

    await expect(pending).rejects.toThrow(/timed out/);
  });

  it('requestCode delegates to sendResyOTP and returns its outcome', async () => {
    mockSendResyOTP.mockResolvedValueOnce('sms');
    const bridge = makeLiveSmsBridge();

    const result = await bridge.requestCode('+14155551234');
    expect(result).toBe('sms');
    expect(mockSendResyOTP).toHaveBeenCalledWith('+14155551234');
  });

  it('clearOtpBridgeState rejects in-flight waiters', async () => {
    const bridge = makeLiveSmsBridge();
    const pending = bridge.waitForCode('+14155551234', 90_000);
    pending.catch(() => {});

    clearOtpBridgeState('+14155551234');

    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it('ingesting twice for the same phone delivers the first code, buffers the second briefly', async () => {
    const bridge = makeLiveSmsBridge();
    const first = bridge.waitForCode('+14155551234');
    ingestOtpCode('+14155551234', '111111');
    await expect(first).resolves.toBe('111111');

    ingestOtpCode('+14155551234', '222222');
    await expect(bridge.waitForCode('+14155551234', 5_000)).resolves.toBe('222222');
  });
});
