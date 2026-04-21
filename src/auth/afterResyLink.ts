import { verifyPaymentStatus, recordPaymentSnapshotTransition } from '../bookings/client.js';
import { resyLinkMessages } from './resyLinkMessages.js';

function paymentSetupUrlForGuest(): string {
  const u = process.env.PAYMENT_SETUP_URL?.trim();
  return u && u.length > 0 ? u : 'https://resy.com/login';
}

/**
 * After Resy JWT is stored: sync payment snapshot for silent checks, and if the partner has no card on file,
 * send a short guided sequence so the guest knows to add one once at Resy.
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
    await sendMessage(chatId, resyLinkMessages.paymentCardNeededSecond(paymentSetupUrlForGuest()));
  } catch (err) {
    console.warn(`[auth] afterResyCredentialsLinked skipped: ${err}`);
  }
}
