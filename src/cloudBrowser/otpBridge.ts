import { sendResyOTP } from '../bookings/client.js';

export type RequestCodeOutcome = 'sms' | 'rate_limited' | false;

export interface ResyOtpSmsBridge {
  /**
   * Ask our reservation partner to text the user an OTP. Returns the outcome of
   * the underlying sendResyOTP call so the caller can bail early on rate-limit.
   */
  requestCode(phoneNumber: string): Promise<RequestCodeOutcome>;
  /**
   * Resolves with the next code ingested for this phone number, or rejects after
   * the given timeout elapses without one arriving.
   */
  waitForCode(phoneNumber: string, timeoutMs?: number): Promise<string>;
}

interface PendingWait {
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingWaits = new Map<string, PendingWait>();
const bufferedCodes = new Map<string, string>();

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Called from the webhook path when a pending cloud-browser OTP is set and the
 * user texts a numeric code back. Delivers the code to a waiting
 * `smsBridge.waitForCode` call, or buffers it briefly if the listener races in.
 */
export function ingestOtpCode(phoneNumber: string, code: string): void {
  const waiter = pendingWaits.get(phoneNumber);
  if (waiter) {
    clearTimeout(waiter.timer);
    pendingWaits.delete(phoneNumber);
    waiter.resolve(code);
    return;
  }
  bufferedCodes.set(phoneNumber, code);
  setTimeout(() => {
    if (bufferedCodes.get(phoneNumber) === code) {
      bufferedCodes.delete(phoneNumber);
    }
  }, 5_000);
}

/**
 * Drops any pending state for this phone number. Called on handoff failure or
 * when the operator wants to cancel a stale wait.
 */
export function clearOtpBridgeState(phoneNumber: string): void {
  const waiter = pendingWaits.get(phoneNumber);
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('[cloudBrowser] OTP wait cancelled'));
    pendingWaits.delete(phoneNumber);
  }
  bufferedCodes.delete(phoneNumber);
}

export function makeLiveSmsBridge(): ResyOtpSmsBridge {
  return {
    async requestCode(phoneNumber: string) {
      clearOtpBridgeState(phoneNumber);
      return sendResyOTP(phoneNumber);
    },
    async waitForCode(phoneNumber: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
      const buffered = bufferedCodes.get(phoneNumber);
      if (buffered) {
        bufferedCodes.delete(phoneNumber);
        return buffered;
      }

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingWaits.delete(phoneNumber);
          reject(new Error(`[cloudBrowser] OTP wait timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pendingWaits.set(phoneNumber, { resolve, reject, timer });
      });
    },
  };
}
