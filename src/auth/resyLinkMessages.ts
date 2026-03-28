export const resyLinkMessages = {
  linkedFirst: "Perfect. You're all set — your reservations are linked.",
  linkedSecond:
    "I'm standing by whenever you're ready for tables, changes, or anything else for the evening.",

  otpSentFirst:
    "I'd be happy to handle that. To secure access to these tables, I just need to verify this number with our reservation partner.",
  otpSentSecond: "You'll receive a code from them in a moment — simply send it back here.",
  otpWaiting: 'Still waiting on that code — check your texts from our reservation partner.',
  otpBad: "That code didn't match — please check the message and try once more.",
  otpServerBusy: 'Our reservation partner is momentarily busy — give it a minute, then try the code again.',
  otpResent: 'I sent a fresh code — use the latest one.',

  emailAskNew: 'Almost there. What email do you use with our reservation partner?',
  emailAskExisting: (name?: string) =>
    name
      ? `Thank you, ${name}. One more detail — which email is on file with our reservation partner?`
      : 'One more detail — which email is on file with our reservation partner?',
  emailReminder: 'I need the email on your reservation profile to finish — the one you use with our partner.',
  emailMismatch: "That email didn't match what's on file — try the one you use with our partner.",

  rateLimitedFirst: 'Our partner is limiting texts to your number for the moment.',
  rateLimitedSecond:
    'No worries — you can still book through me without linking. Just tell me what you need.',
  otpSendFailedFirst: "I couldn't send a verification code to this number right now.",
  otpSendFailedSecond:
    "Not a problem — you can still book through me directly. Just tell me what you need and I'll handle it.",

  manualConnectFirst: "I'm having trouble finishing the link automatically.",
  manualConnectSecond:
    'You can still book through me without linking — just tell me what you need. Or try linking again later by texting "link my resy".',

  /**
   * Guided entry: stable login first (avoids fragile deep links). Optional override for PAYMENT_SETUP_URL / vault hosts.
   */
  paymentFrontDesk: (url = 'https://resy.com/login') =>
    `${url} — Once you've signed in at the front desk, please tap your profile icon to add a payment method—I'll be standing by to confirm the second it's added.`,

  /** Right after Resy account is linked, if /2/user shows no saved card */
  paymentCardNeededFirst:
    "We're close — your Resy account is linked, but our partner still needs a card on file before I can hold a table for you.",

  paymentCardNeededSecond: (url: string) =>
    `No worries — you only do this once. Head to Resy, sign in, and add a payment method under your profile. After that, bookings stay seamless. Here's the stable sign-in link: ${url}`,
} as const;
