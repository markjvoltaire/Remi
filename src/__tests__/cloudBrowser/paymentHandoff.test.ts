import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runPaymentHandoff, type PaymentHandoffDeps } from '../../cloudBrowser/paymentHandoff.js';
import type { BrowserDriver } from '../../cloudBrowser/resyInject.js';
import type { ResyOtpSmsBridge } from '../../cloudBrowser/otpBridge.js';
import type { CloudBrowserSession } from '../../cloudBrowser/client.js';

function makeSession(overrides: Partial<CloudBrowserSession> = {}): CloudBrowserSession {
  return {
    id: 'sess_123',
    connectUrl: 'wss://connect',
    liveViewUrl: 'https://live.browserbase.com/sess_123',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    ...overrides,
  };
}

function makeDriver(overrides: Partial<BrowserDriver> = {}): BrowserDriver {
  const base: BrowserDriver = {
    goto: vi.fn().mockResolvedValue(undefined),
    addCookies: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    isAuthenticatedResy: vi.fn().mockResolvedValue(true),
    actClickSignIn: vi.fn().mockResolvedValue(undefined),
    actFillPhone: vi.fn().mockResolvedValue(undefined),
    actEnterCode: vi.fn().mockResolvedValue(undefined),
    actClickAddCard: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

function makeDeps(session: CloudBrowserSession, driver: BrowserDriver): PaymentHandoffDeps & {
  mocks: {
    createSession: ReturnType<typeof vi.fn>;
    closeSession: ReturnType<typeof vi.fn>;
    connectDriver: ReturnType<typeof vi.fn>;
    disconnectDriver: ReturnType<typeof vi.fn>;
  };
} {
  const createSession = vi.fn().mockResolvedValue(session);
  const closeSession = vi.fn().mockResolvedValue(undefined);
  const connectDriver = vi.fn().mockResolvedValue(driver);
  const disconnectDriver = vi.fn().mockResolvedValue(undefined);
  return {
    createSession,
    closeSession,
    connectDriver,
    disconnectDriver,
    mocks: { createSession, closeSession, connectDriver, disconnectDriver },
  };
}

function makeSmsBridge(overrides: Partial<ResyOtpSmsBridge> = {}): ResyOtpSmsBridge {
  return {
    requestCode: vi.fn().mockResolvedValue('sms'),
    waitForCode: vi.fn().mockResolvedValue('123456'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runPaymentHandoff', () => {
  it('cookie path: returns handoff info, navigates to payment-methods, clicks Add Card, leaves session alive', async () => {
    const session = makeSession();
    const driver = makeDriver({
      isAuthenticatedResy: vi.fn().mockResolvedValue(true),
    });
    const deps = makeDeps(session, driver);
    const smsBridge = makeSmsBridge();

    const result = await runPaymentHandoff(
      { phoneNumber: '+14155551234', resyJwt: 'jwt_abc', smsBridge },
      deps,
    );

    expect(result).not.toBeNull();
    expect(result?.liveViewUrl).toBe('https://live.browserbase.com/sess_123');
    expect(result?.sessionId).toBe('sess_123');
    expect(result?.authPath).toBe('cookie');

    expect(deps.mocks.createSession).toHaveBeenCalledTimes(1);
    expect(deps.mocks.connectDriver).toHaveBeenCalledWith(session);

    expect(driver.addCookies).toHaveBeenCalledTimes(1);
    const cookieCall = (driver.addCookies as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ name: string; value: string }>;
    expect(cookieCall.every(c => c.value === 'jwt_abc')).toBe(true);

    expect(driver.goto).toHaveBeenCalledWith('https://resy.com/account/payment-methods');
    expect(driver.actClickAddCard).toHaveBeenCalled();

    expect(smsBridge.requestCode).not.toHaveBeenCalled();
    expect(deps.mocks.closeSession).not.toHaveBeenCalled();
    expect(deps.mocks.disconnectDriver).toHaveBeenCalledTimes(1);
  });

  it('OTP fallback path: cookie rejected, requests SMS, submits code, returns handoff info', async () => {
    const session = makeSession();
    const isAuth = vi.fn()
      .mockResolvedValueOnce(false) // cookie check rejected
      .mockResolvedValue(true);     // after OTP submit
    const driver = makeDriver({ isAuthenticatedResy: isAuth });
    const deps = makeDeps(session, driver);
    const smsBridge = makeSmsBridge({
      requestCode: vi.fn().mockResolvedValue('sms'),
      waitForCode: vi.fn().mockResolvedValue('424242'),
    });

    const result = await runPaymentHandoff(
      { phoneNumber: '+14155551234', resyJwt: 'jwt_abc', smsBridge },
      deps,
    );

    expect(result?.authPath).toBe('otp');
    expect(smsBridge.requestCode).toHaveBeenCalledWith('+14155551234');
    expect(smsBridge.waitForCode).toHaveBeenCalled();
    expect(driver.actEnterCode).toHaveBeenCalledWith('424242');
    expect(driver.actClickAddCard).toHaveBeenCalled();
    expect(deps.mocks.closeSession).not.toHaveBeenCalled();
  });

  it('both fail: returns null, closes session, disconnects driver', async () => {
    const session = makeSession();
    const driver = makeDriver({
      isAuthenticatedResy: vi.fn().mockResolvedValue(false),
    });
    const deps = makeDeps(session, driver);
    const smsBridge = makeSmsBridge({
      requestCode: vi.fn().mockResolvedValue('rate_limited'),
    });

    const result = await runPaymentHandoff(
      { phoneNumber: '+14155551234', resyJwt: 'jwt_abc', smsBridge },
      deps,
    );

    expect(result).toBeNull();
    expect(deps.mocks.closeSession).toHaveBeenCalledWith('sess_123');
    expect(deps.mocks.disconnectDriver).toHaveBeenCalled();
  });

  it('createSession throw: returns null and does not connect a driver', async () => {
    const deps: PaymentHandoffDeps = {
      createSession: vi.fn().mockRejectedValue(new Error('boom')),
      closeSession: vi.fn().mockResolvedValue(undefined),
      connectDriver: vi.fn(),
      disconnectDriver: vi.fn(),
    };
    const smsBridge = makeSmsBridge();

    const result = await runPaymentHandoff(
      { phoneNumber: '+14155551234', resyJwt: 'jwt_abc', smsBridge },
      deps,
    );

    expect(result).toBeNull();
    expect(deps.connectDriver).not.toHaveBeenCalled();
  });
});
