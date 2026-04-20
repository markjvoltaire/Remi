import { verifyPaymentStatus, recordPaymentSnapshotTransition } from '../bookings/client.js';
import { resyLinkMessages } from './resyLinkMessages.js';
import { redactPhone } from '../utils/redact.js';
import {
  isCloudBrowserReady,
  runPaymentHandoff,
  makeLivePaymentHandoffDeps,
  makeLiveSmsBridge,
} from '../cloudBrowser/index.js';
import { setPendingCloudBrowserOtp } from './db.js';

function paymentSetupUrlForGuest(): string {
  const u = process.env.PAYMENT_SETUP_URL?.trim();
  return u && u.length > 0 ? u : 'https://resy.com/login';
}

/**
 * After Resy JWT is stored: sync payment snapshot for silent checks, and if the partner has no card on file,
 * send a short guided sequence so the guest knows to add one once at Resy.
 *
 * When CLOUD_BROWSER_ENABLED=true, we spin up a Browserbase session, park it
 * on the add-card page under the user's identity, and hand them a live-view
 * URL to tap. Fall back to the stable `paymentFrontDesk` URL on any failure.
 */
export async function afterResyCredentialsLinked(params: {
  phoneNumber: string;
  chatId: string;
  resyAuthToken: string;
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
}): Promise<void> {
  const { phoneNumber, chatId, resyAuthToken, sendMessage } = params;
  try {
    const status = await verifyPaymentStatus(resyAuthToken);
    recordPaymentSnapshotTransition(phoneNumber, status);
    if (status.hasPaymentMethod) {
      return;
    }
    await new Promise(r => setTimeout(r, 600));
    await sendMessage(chatId, resyLinkMessages.paymentCardNeededFirst);
    await new Promise(r => setTimeout(r, 500 + Math.random() * 350));

    if (isCloudBrowserReady()) {
      try {
        const handoff = await runPaymentHandoff(
          {
            phoneNumber,
            resyJwt: resyAuthToken,
            smsBridge: makeLiveSmsBridge(),
          },
          makeLivePaymentHandoffDeps(),
        );
        if (handoff) {
          if (handoff.authPath === 'otp') {
            await setPendingCloudBrowserOtp(phoneNumber, handoff.sessionId);
          }
          await sendMessage(chatId, resyLinkMessages.paymentCardNeededSecond(handoff.liveViewUrl));
          console.log(
            `[auth] cloud-browser handoff ready session=${handoff.sessionId} authPath=${handoff.authPath} phone=${redactPhone(phoneNumber)}`,
          );
          return;
        }
        console.warn(
          `[auth] cloud-browser handoff returned null, falling back to paymentFrontDesk phone=${redactPhone(phoneNumber)}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[auth] cloud-browser handoff threw (${msg}), falling back to paymentFrontDesk`);
      }
    }

    await sendMessage(chatId, resyLinkMessages.paymentCardNeededSecond(paymentSetupUrlForGuest()));
    console.log(`[auth] Notified ${redactPhone(phoneNumber)} — Resy linked but no payment method on file`);
  } catch (err) {
    console.warn(`[auth] afterResyCredentialsLinked skipped: ${err}`);
  }
}
