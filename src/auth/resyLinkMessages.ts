export const resyLinkMessages = {
  linkedFirst: "you're all set! your resy account is connected",
  linkedSecond: 'i can search restaurants, find open tables, make reservations, and manage your bookings - just text me what you need',

  otpSentFirst: 'hey! i just sent a verification code to this number from resy',
  otpSentSecond: 'send me the 6-digit code to connect your account',
  otpWaiting: "i'm still waiting for your resy verification code - check your texts for a 6-digit code from resy",
  otpBad: "that code didn't work - check the text from resy and try again",
  otpServerBusy: 'resy is having trouble verifying codes right now - try again in a minute',
  otpResent: 'just sent a new code - try again with the fresh one',

  emailAskNew: 'almost there! i need your resy email to finish connecting - what email did you use for resy?',
  emailAskExisting: (name?: string) =>
    name
      ? `got it ${name}! one more step - what's the email address on your resy account?`
      : "one more step - what's the email address on your resy account?",
  emailReminder: 'i need the email address on your resy account to finish connecting - what email did you use to sign up for resy?',
  emailMismatch: "that email didn't match your resy account - try the email address you used to sign up for resy",

  rateLimitedFirst: 'resy is temporarily blocking verification texts to your number (too many recent attempts)',
  rateLimitedSecond: 'you can connect by pasting your resy auth token directly - go to resy.com, open browser dev tools, and copy the x-resy-auth-token header value, then text it to me',
  otpSendFailedFirst: "i couldn't send a verification code to this number - make sure you have a resy account linked to this phone number",
  otpSendFailedSecond: 'alternatively, you can paste your resy auth token directly - go to resy.com, log in, open dev tools, and copy the x-resy-auth-token header from any api request',

  manualConnectFirst: "i'm having trouble connecting your account automatically",
  manualConnectSecond: 'you can connect manually: log into resy.com, open browser dev tools (F12), go to Network tab, click any request, and copy the "x-resy-auth-token" header value - then paste it here',
} as const;
