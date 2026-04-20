export const resyLinkMessages = {
  linkedFirst: "Perfect. You're all set. Your reservations are linked.",
  linkedSecond:
    "I'm standing by whenever you're ready for tables, changes, or anything else for the evening.",

  otpSentFirst:
    "I'd be happy to handle that. To secure access to these tables, I just need to verify this number with our reservation partner.",
  otpSentSecond: "You'll receive a code from them in a moment. Send it back here.",
  otpWaiting: 'Still waiting on that code. Check your texts from our reservation partner.',
  otpBad: "That code didn't match. Check the message and try once more.",
  otpServerBusy: 'Our reservation partner is momentarily busy. Give it a minute, then try the code again.',
  otpResent: 'I sent a fresh code. Use the latest one.',

  emailAskNew: 'Almost there. What email should I use to set up your account with our reservation partner?',
  emailAskExisting: (name?: string) =>
    name
      ? `Thank you, ${name}. One more detail: which email is on file with our reservation partner?`
      : 'One more detail: which email is on file with our reservation partner?',
  emailReminder: 'I need the email on your reservation profile to finish. The one you use with our partner.',
  emailMismatch: "That email didn't match what's on file. Try the one you use with our partner.",

  rateLimitedFirst: 'Our partner is limiting texts to your number for the moment.',
  rateLimitedSecond:
    "No worries. You can still book through me without linking. Just tell me what you need.",
  otpSendFailedFirst: "I couldn't send a verification code to this number right now.",
  otpSendFailedSecond:
    "Not a problem. You can still book through me directly. Just tell me what you need and I'll handle it.",

  manualConnectFirst: "I'm having trouble finishing the link automatically.",
  manualConnectSecond:
    'You can still book through me without linking. Just tell me what you need, or try linking again later by saying "link my reservations".',

  /**
   * Guided entry: stable login first (avoids fragile deep links). Optional override for PAYMENT_SETUP_URL / vault hosts.
   */
  paymentFrontDesk: (url = 'https://resy.com/login') =>
    `${url}. Once you've signed in at the front desk, tap your profile icon to add a payment method. I'll be standing by to confirm the second it's added.`,

  /** Right after the reservation partner account is linked, if /2/user shows no saved card */
  paymentCardNeededFirst:
    "We're close. Your account with our reservation partner is linked, but they still need a card on file before I can hold a table for you.",

  paymentCardNeededSecond: (url: string) =>
    `No worries. You only do this once. Tap here, sign in at our partner's site, and add a payment method under your profile. After that, bookings stay seamless: ${url}`,

  /** No account yet with our reservation partner (isNewUser branch) */
  noResyAccountFirst:
    "Looks like you're new to our reservation partner. One-time setup before I can book for you. Create an account at https://resy.com/signup and add a card to your profile (about 60 seconds).",
  noResyAccountSecond:
    "That's the only time you'll do this. From then on it's just a text to me. Say 'book sushi friday at 8' and I take care of the rest.",
} as const;
