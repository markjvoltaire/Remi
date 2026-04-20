import { createSession, closeSession, type CloudBrowserSession } from './client.js';
import { authenticateResy, type BrowserDriver, type AuthResult } from './resyInject.js';
import type { ResyOtpSmsBridge } from './otpBridge.js';
import { redactPhone } from '../utils/redact.js';

export interface PaymentHandoffResult {
  liveViewUrl: string;
  sessionId: string;
  expiresAt: Date;
  authPath: AuthResult;
}

export interface RunPaymentHandoffParams {
  phoneNumber: string;
  resyJwt: string;
  smsBridge: ResyOtpSmsBridge;
}

/**
 * Optional DI hooks for tests and for future provider-swap. Tests override
 * these to exercise the handoff without spinning up a real Browserbase session.
 */
export interface PaymentHandoffDeps {
  createSession: (opts?: { timeoutMs?: number }) => Promise<CloudBrowserSession>;
  closeSession: (id: string) => Promise<void>;
  connectDriver: (session: CloudBrowserSession) => Promise<BrowserDriver>;
  disconnectDriver: (driver: BrowserDriver) => Promise<void>;
}

/**
 * Spin up a Browserbase session, authenticate it as the user, park it on the
 * add-card page, and return the live-view URL for the user to tap. Returns
 * null on any failure so the caller can fall back to the paymentFrontDesk SMS.
 *
 * On success the session stays alive until CLOUD_BROWSER_SESSION_TIMEOUT_MS so
 * the live-view link remains tappable; we only tear down on failure.
 */
export async function runPaymentHandoff(
  params: RunPaymentHandoffParams,
  deps: PaymentHandoffDeps,
): Promise<PaymentHandoffResult | null> {
  const { phoneNumber, resyJwt, smsBridge } = params;
  const redacted = redactPhone(phoneNumber);

  let session: CloudBrowserSession | null = null;
  let driver: BrowserDriver | null = null;

  try {
    session = await deps.createSession();
    console.log(`[cloudBrowser] session created session=${session.id} phone=${redacted}`);

    driver = await deps.connectDriver(session);

    const authPath = await authenticateResy(driver, { resyJwt, phoneNumber, smsBridge });
    if (authPath === 'failed') {
      console.warn(`[cloudBrowser] auth failed session=${session.id} phone=${redacted}`);
      await safeCleanup(deps, driver, session);
      return null;
    }

    await driver.goto('https://resy.com/account/payment-methods');
    try {
      await driver.actClickAddCard();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[cloudBrowser] actClickAddCard failed session=${session.id}: ${msg}`);
    }

    console.log(`[cloudBrowser] handoff ready session=${session.id} phone=${redacted} authPath=${authPath}`);
    await deps.disconnectDriver(driver);

    return {
      liveViewUrl: session.liveViewUrl,
      sessionId: session.id,
      expiresAt: session.expiresAt,
      authPath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cloudBrowser] handoff threw phone=${redacted}: ${msg}`);
    await safeCleanup(deps, driver, session);
    return null;
  }
}

async function safeCleanup(
  deps: PaymentHandoffDeps,
  driver: BrowserDriver | null,
  session: CloudBrowserSession | null,
): Promise<void> {
  if (driver) {
    try { await deps.disconnectDriver(driver); } catch { /* noop */ }
  }
  if (session) {
    try { await deps.closeSession(session.id); } catch { /* noop */ }
  }
}

/**
 * Production-bound defaults. Wires the Browserbase SDK client and a Playwright +
 * Stagehand BrowserDriver. Kept at module scope so the caller needs no knowledge
 * of cloud-browser internals.
 */
export function makeLivePaymentHandoffDeps(): PaymentHandoffDeps {
  return {
    createSession: (opts) => createSession(opts),
    closeSession: (id) => closeSession(id),
    connectDriver: (session) => connectLiveDriver(session),
    disconnectDriver: (driver) => disconnectLiveDriver(driver),
  };
}

async function connectLiveDriver(session: CloudBrowserSession): Promise<BrowserDriver> {
  const { chromium } = await import('playwright-core');
  const { Stagehand } = await import('@browserbasehq/stagehand');
  const { getBrowserbaseCreds } = await import('./config.js');

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const defaultContext = browser.contexts()[0];
  const context = defaultContext ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  const creds = getBrowserbaseCreds();
  const stagehand = new (Stagehand as unknown as new (opts: Record<string, unknown>) => {
    init: () => Promise<void>;
    act: (instruction: string) => Promise<unknown>;
    close: (opts?: { force?: boolean }) => Promise<void>;
  })({
    env: 'BROWSERBASE',
    apiKey: creds.apiKey,
    projectId: creds.projectId,
    browserbaseSessionID: session.id,
  });
  await stagehand.init();

  const liveDriver: BrowserDriver & LiveDriverInternals = {
    __browser: browser,
    __stagehand: stagehand,
    async goto(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },
    async addCookies(cookies) {
      await context.addCookies(cookies);
    },
    async evaluate(fnSrc, arg) {
      const fn = new Function(`return (${fnSrc})`)() as (a: unknown) => unknown;
      return page.evaluate(fn as (a: unknown) => unknown, arg) as Promise<never>;
    },
    async isAuthenticatedResy() {
      const url = page.url();
      if (!url.includes('resy.com')) return false;
      const hasUserChrome = await page.evaluate(() => {
        const text = document.body?.innerText ?? '';
        return /account|profile|sign out|log out/i.test(text) && !/sign in|log in/i.test(text);
      });
      return hasUserChrome;
    },
    async actClickSignIn() {
      await stagehand.act('click the Sign In or Log In button');
    },
    async actFillPhone(phoneNumber) {
      await stagehand.act(`fill the phone number field with ${phoneNumber}`);
      await stagehand.act('click Continue or Next');
    },
    async actEnterCode(code) {
      await stagehand.act(`enter the verification code ${code} and submit`);
    },
    async actClickAddCard() {
      await stagehand.act('click "Add a payment method" or "Add Card"');
    },
  };

  return liveDriver;
}

interface LiveDriverInternals {
  __browser: { close: () => Promise<void> };
  __stagehand: { close: (opts?: { force?: boolean }) => Promise<void> };
}

async function disconnectLiveDriver(driver: BrowserDriver): Promise<void> {
  const internals = driver as BrowserDriver & Partial<LiveDriverInternals>;
  try { await internals.__stagehand?.close({ force: false }); } catch { /* noop */ }
  try { await internals.__browser?.close(); } catch { /* noop */ }
}
