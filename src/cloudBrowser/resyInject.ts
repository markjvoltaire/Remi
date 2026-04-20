import type { ResyOtpSmsBridge } from './otpBridge.js';
import { redactPhone } from '../utils/redact.js';

export interface CookieInput {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

/**
 * Minimal browser abstraction the inject flow needs. The live driver wraps a
 * Playwright BrowserContext (connected to Browserbase over CDP) plus a Stagehand
 * instance attached to the same session. Tests inject a mock driver directly.
 */
export interface BrowserDriver {
  goto(url: string): Promise<void>;
  addCookies(cookies: CookieInput[]): Promise<void>;
  /** Run a function inside the page context; fn receives one serialised arg. */
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  /** Probe the current authenticated-state of resy.com. */
  isAuthenticatedResy(): Promise<boolean>;
  /** LLM-driven actions used only when cookie injection failed. */
  actClickSignIn(): Promise<void>;
  actFillPhone(phoneNumber: string): Promise<void>;
  actEnterCode(code: string): Promise<void>;
  /** Click the "Add Card" affordance on the payment-methods page. */
  actClickAddCard(): Promise<void>;
}

/**
 * Speculative list. We try every plausible cookie name Resy has used because
 * their session mechanism is undocumented. Dead entries are harmless.
 */
const CANDIDATE_COOKIE_NAMES = [
  'auth_token',
  'resy_auth_token',
  'resy_session',
  'resy_current_user',
  'resy_current_user_v2',
  '__auth',
];

export type AuthResult = 'cookie' | 'otp' | 'failed';

/**
 * Bring the cloud browser into an authenticated resy.com state, trying cookie
 * injection first and phone-OTP as a graceful fallback. Returns the path that
 * succeeded so callers can log cookie-vs-otp ratio in production.
 */
export async function authenticateResy(
  driver: BrowserDriver,
  opts: {
    resyJwt: string;
    phoneNumber: string;
    smsBridge: ResyOtpSmsBridge;
    otpTimeoutMs?: number;
  },
): Promise<AuthResult> {
  const { resyJwt, phoneNumber, smsBridge, otpTimeoutMs } = opts;

  try {
    await driver.goto('https://resy.com/');
    const cookies: CookieInput[] = CANDIDATE_COOKIE_NAMES.map(name => ({
      name,
      value: resyJwt,
      domain: '.resy.com',
      path: '/',
      secure: true,
    }));
    await driver.addCookies(cookies);
    await driver.evaluate<void>(
      `(token) => { try { localStorage.setItem('resy_auth_token', token); localStorage.setItem('authToken', token); } catch (_) {} }`,
      resyJwt,
    );
    await driver.goto('https://resy.com/account');
    if (await driver.isAuthenticatedResy()) {
      console.log(`[cloudBrowser] authenticateResy cookie path succeeded phone=${redactPhone(phoneNumber)}`);
      return 'cookie';
    }
    console.log(`[cloudBrowser] authenticateResy cookie path rejected, falling back to OTP phone=${redactPhone(phoneNumber)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cloudBrowser] authenticateResy cookie path threw: ${msg}`);
  }

  try {
    await driver.goto('https://resy.com/');
    await driver.actClickSignIn();
    await driver.actFillPhone(phoneNumber);

    const otpOutcome = await smsBridge.requestCode(phoneNumber);
    if (otpOutcome !== 'sms') {
      console.warn(`[cloudBrowser] authenticateResy OTP request returned ${String(otpOutcome)} phone=${redactPhone(phoneNumber)}`);
      return 'failed';
    }

    const code = await smsBridge.waitForCode(phoneNumber, otpTimeoutMs);
    await driver.actEnterCode(code);

    if (await driver.isAuthenticatedResy()) {
      console.log(`[cloudBrowser] authenticateResy OTP fallback succeeded phone=${redactPhone(phoneNumber)}`);
      return 'otp';
    }
    console.warn(`[cloudBrowser] authenticateResy OTP fallback did not land on authenticated page phone=${redactPhone(phoneNumber)}`);
    return 'failed';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cloudBrowser] authenticateResy OTP fallback threw: ${msg}`);
    return 'failed';
  }
}
