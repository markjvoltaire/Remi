import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent, SQSRecord, Context } from 'aws-lambda';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSendMessage = vi.fn().mockResolvedValue({});
const mockMarkAsRead = vi.fn().mockResolvedValue(undefined);
const mockStartTyping = vi.fn().mockResolvedValue(undefined);
const mockSendReaction = vi.fn().mockResolvedValue(undefined);
const mockShareContactCard = vi.fn().mockResolvedValue(undefined);
const mockRenameGroupChat = vi.fn().mockResolvedValue(undefined);
const mockGetChat = vi.fn().mockResolvedValue({
  id: 'chat_1',
  display_name: null,
  handles: [
    { handle: '+14155551234', service: 'iMessage' },
    { handle: '+14155550000', service: 'iMessage' },
  ],
  is_group: false,
  service: 'iMessage',
});

vi.mock('../../blooio/client.js', () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  markAsRead: (...args: unknown[]) => mockMarkAsRead(...args),
  startTyping: (...args: unknown[]) => mockStartTyping(...args),
  sendReaction: (...args: unknown[]) => mockSendReaction(...args),
  shareContactCard: (...args: unknown[]) => mockShareContactCard(...args),
  getChat: (...args: unknown[]) => mockGetChat(...args),
  renameGroupChat: (...args: unknown[]) => mockRenameGroupChat(...args),
}));

const mockChat = vi.fn().mockResolvedValue({
  text: 'hi there!',
  reaction: null,
  effect: null,
  renameChat: null,
  rememberedUser: null,
});
const mockGetGroupChatAction = vi.fn().mockResolvedValue({ action: 'respond' });
const mockGetTextForEffect = vi.fn().mockResolvedValue('wow!');

vi.mock('../../claude/client.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  getGroupChatAction: (...args: unknown[]) => mockGetGroupChatAction(...args),
  getTextForEffect: (...args: unknown[]) => mockGetTextForEffect(...args),
}));

const mockGetUserProfile = vi.fn().mockResolvedValue(null);
const mockAddMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('../../state/conversation.js', () => ({
  getUserProfile: (...args: unknown[]) => mockGetUserProfile(...args),
  addMessage: (...args: unknown[]) => mockAddMessage(...args),
}));

const mockGetUser = vi.fn().mockResolvedValue(null);
const mockCreateUser = vi.fn().mockResolvedValue({ phoneNumber: '+14155551234' });
const mockLoadUserContext = vi.fn();
const mockConsumeJustOnboarded = vi.fn().mockResolvedValue(false);
const mockSetPendingOTP = vi.fn().mockResolvedValue(undefined);
const mockGetPendingOTP = vi.fn().mockResolvedValue(null);
const mockClearPendingOTP = vi.fn().mockResolvedValue(undefined);
const mockSetPendingChallenge = vi.fn().mockResolvedValue(undefined);
const mockGetPendingChallenge = vi.fn().mockResolvedValue(null);
const mockClearPendingChallenge = vi.fn().mockResolvedValue(undefined);
const mockSetCredentials = vi.fn().mockResolvedValue(undefined);
const mockClearSignedOut = vi.fn().mockResolvedValue(undefined);
const mockAfterResyCredentialsLinked = vi.fn().mockResolvedValue(undefined);

vi.mock('../../auth/index.js', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  createUser: (...args: unknown[]) => mockCreateUser(...args),
  loadUserContext: (...args: unknown[]) => mockLoadUserContext(...args),
  consumeJustOnboarded: (...args: unknown[]) => mockConsumeJustOnboarded(...args),
  setPendingOTP: (...args: unknown[]) => mockSetPendingOTP(...args),
  getPendingOTP: (...args: unknown[]) => mockGetPendingOTP(...args),
  clearPendingOTP: (...args: unknown[]) => mockClearPendingOTP(...args),
  setPendingChallenge: (...args: unknown[]) => mockSetPendingChallenge(...args),
  getPendingChallenge: (...args: unknown[]) => mockGetPendingChallenge(...args),
  clearPendingChallenge: (...args: unknown[]) => mockClearPendingChallenge(...args),
  setCredentials: (...args: unknown[]) => mockSetCredentials(...args),
  clearSignedOut: (...args: unknown[]) => mockClearSignedOut(...args),
  afterResyCredentialsLinked: (...args: unknown[]) => mockAfterResyCredentialsLinked(...args),
}));

const mockSendResyOTP = vi.fn().mockResolvedValue('sms');
const mockVerifyResyOTP = vi.fn();
const mockCompleteResyChallenge = vi.fn();
const mockRegisterResyUser = vi.fn().mockResolvedValue(null);
const mockVerifyPaymentStatus = vi.fn().mockResolvedValue({
  hasPaymentMethod: true,
  defaultPaymentMethodId: 1,
  fingerprint: '1',
});
const mockRecordPaymentSnapshotTransition = vi.fn().mockReturnValue({ paymentBecameAvailable: false });
const mockMessageSuggestsBookingIntent = vi.fn().mockReturnValue(true);

vi.mock('../../bookings/index.js', () => ({
  sendResyOTP: (...args: unknown[]) => mockSendResyOTP(...args),
  verifyResyOTP: (...args: unknown[]) => mockVerifyResyOTP(...args),
  completeResyChallenge: (...args: unknown[]) => mockCompleteResyChallenge(...args),
  registerResyUser: (...args: unknown[]) => mockRegisterResyUser(...args),
  verifyPaymentStatus: (...args: unknown[]) => mockVerifyPaymentStatus(...args),
  recordPaymentSnapshotTransition: (...args: unknown[]) => mockRecordPaymentSnapshotTransition(...args),
  messageSuggestsBookingIntent: (...args: unknown[]) => mockMessageSuggestsBookingIntent(...args),
}));

// Mock storage getItem/putItem for chat count
const mockDbGetItem = vi.fn().mockResolvedValue(null);
const mockDbPutItem = vi.fn().mockResolvedValue(undefined);
vi.mock('../../db/storage.js', () => ({
  getItem: (...args: unknown[]) => mockDbGetItem(...args),
  putItem: (...args: unknown[]) => mockDbPutItem(...args),
}));

import { handler } from '../../handlers/processor.js';

function makeSQSEvent(text: string, overrides: Record<string, unknown> = {}): SQSEvent {
  const webhookEvent = {
    event: 'message.received',
    message_id: 'msg_1',
    sender: '+14155551234',
    external_id: 'chat_1',
    internal_id: '+14155550000',
    protocol: 'imessage',
    text,
    received_at: Date.now(),
    attachments: [],
    is_group: false,
    ...overrides,
  };

  const record: SQSRecord = {
    messageId: 'sqs_1',
    receiptHandle: 'rh_1',
    body: JSON.stringify(webhookEvent),
    attributes: {} as SQSRecord['attributes'],
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123:queue',
    awsRegion: 'us-east-1',
  };

  return { Records: [record] };
}

const dummyContext: Context = {
  callbackWaitsForEmptyEventLoop: true,
  functionName: 'test',
  functionVersion: '1',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123:function:test',
  memoryLimitInMB: '128',
  awsRequestId: 'req1',
  logGroupName: '/test',
  logStreamName: 'stream1',
  getRemainingTimeInMillis: () => 60000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbGetItem.mockResolvedValue(null);
  mockDbPutItem.mockResolvedValue(undefined);
  mockGetPendingOTP.mockResolvedValue(null);
  mockGetPendingChallenge.mockResolvedValue(null);
  mockGetUserProfile.mockResolvedValue(null);
  // Restore default 1:1 chat (2 handles = not a group)
  mockGetChat.mockResolvedValue({
    id: 'chat_1',
    display_name: null,
    handles: [
      { handle: '+14155551234', service: 'iMessage' },
      { handle: '+14155550000', service: 'iMessage' },
    ],
    is_group: false,
    service: 'iMessage',
  });
  mockChat.mockResolvedValue({
    text: 'hi there!',
    reaction: null,
    effect: null,
    renameChat: null,
    rememberedUser: null,
  });
  mockMessageSuggestsBookingIntent.mockReturnValue(true);
  mockVerifyPaymentStatus.mockResolvedValue({
    hasPaymentMethod: true,
    defaultPaymentMethodId: 1,
    fingerprint: '1',
  });
  mockRecordPaymentSnapshotTransition.mockReturnValue({ paymentBecameAvailable: false });
  mockAfterResyCredentialsLinked.mockResolvedValue(undefined);
});

describe('processor handler', () => {
  it('inline JWT stores credentials directly', async () => {
    const jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

    await handler(makeSQSEvent(jwtToken), dummyContext, () => {});

    expect(mockSetCredentials).toHaveBeenCalledWith('+14155551234', { resyAuthToken: jwtToken });
    expect(mockSendMessage).toHaveBeenCalled();
  });

  it('OTP code triggers verification flow', async () => {
    mockGetPendingOTP.mockResolvedValue({ chatId: 'chat_1', sentAt: new Date() });
    mockVerifyResyOTP.mockResolvedValue({ token: 'resy_tok_123' });

    await handler(makeSQSEvent('123456'), dummyContext, () => {});

    expect(mockVerifyResyOTP).toHaveBeenCalledWith('+14155551234', '123456');
    expect(mockSetCredentials).toHaveBeenCalledWith('+14155551234', { resyAuthToken: 'resy_tok_123' });
  });

  it('email during pending challenge triggers challenge completion', async () => {
    mockGetPendingChallenge.mockResolvedValue({
      chatId: 'chat_1',
      claimToken: 'ct_1',
      challengeId: 'ch_1',
      mobileNumber: '+14155551234',
      firstName: 'Alice',
      requiredFields: [{ name: 'em_address', type: 'email', message: 'Enter email' }],
      sentAt: new Date().toISOString(),
    });
    mockCompleteResyChallenge.mockResolvedValue('resy_tok_from_challenge');

    await handler(makeSQSEvent('alice@example.com'), dummyContext, () => {});

    expect(mockCompleteResyChallenge).toHaveBeenCalled();
    expect(mockSetCredentials).toHaveBeenCalledWith('+14155551234', { resyAuthToken: 'resy_tok_from_challenge' });
  });

  it('no house account and no credentials sends fallback message (no forced OTP)', async () => {
    mockLoadUserContext.mockResolvedValue(null);
    mockGetUser.mockResolvedValue(null);

    await handler(makeSQSEvent('find me a restaurant'), dummyContext, () => {});

    expect(mockSendResyOTP).not.toHaveBeenCalled();
    expect(mockSetPendingOTP).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      'chat_1',
      "hey, i'm having trouble connecting to our reservation system right now. sit tight — i'll sort it out.",
    );
  });

  it('house account user reaches Claude with isHouseAccount true and skips payment verify', async () => {
    mockLoadUserContext.mockResolvedValue({
      user: { phoneNumber: '+14155551234', createdAt: new Date(), lastActive: new Date(), onboardingComplete: false },
      bookingsCredentials: { resyAuthToken: 'house_tok' },
      isHouseAccount: true,
    });

    await handler(makeSQSEvent('find me sushi in NYC'), dummyContext, () => {});

    expect(mockVerifyPaymentStatus).not.toHaveBeenCalled();
    expect(mockChat).toHaveBeenCalledWith(
      'chat_1',
      'find me sushi in NYC',
      [],
      [],
      expect.objectContaining({
        isHouseAccount: true,
        bookingsCredentials: { resyAuthToken: 'house_tok' },
      }),
    );
  });

  it('opt-in link my resy on house account triggers OTP', async () => {
    mockLoadUserContext.mockResolvedValue({
      user: { phoneNumber: '+14155551234', createdAt: new Date(), lastActive: new Date(), onboardingComplete: false },
      bookingsCredentials: { resyAuthToken: 'house_tok' },
      isHouseAccount: true,
    });
    mockSendResyOTP.mockResolvedValue('sms');

    await handler(makeSQSEvent('link my resy account'), dummyContext, () => {});

    expect(mockSendResyOTP).toHaveBeenCalledWith('+14155551234');
    expect(mockSetPendingOTP).toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('group chat message runs classifier', async () => {
    mockLoadUserContext.mockResolvedValue({
      user: { phoneNumber: '+14155551234', createdAt: new Date(), lastActive: new Date(), onboardingComplete: true },
      bookingsCredentials: { resyAuthToken: 'tok' },
      isHouseAccount: false,
    });
    mockGetChat.mockResolvedValue({
      id: 'chat_1',
      display_name: 'Friends',
      handles: [
        { handle: '+14155551234', service: 'iMessage' },
        { handle: '+14155550000', service: 'iMessage' },
        { handle: '+14155559999', service: 'iMessage' }, // 3 handles = group
      ],
      is_group: true,
      service: 'iMessage',
    });
    mockGetGroupChatAction.mockResolvedValue({ action: 'ignore' });

    await handler(makeSQSEvent('hey everyone'), dummyContext, () => {});

    expect(mockGetGroupChatAction).toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled(); // Ignored
  });

  it('main flow calls Claude chat and sends response', async () => {
    mockLoadUserContext.mockResolvedValue({
      user: { phoneNumber: '+14155551234', createdAt: new Date(), lastActive: new Date(), onboardingComplete: true },
      bookingsCredentials: { resyAuthToken: 'tok' },
      isHouseAccount: false,
    });
    mockChat.mockResolvedValue({
      text: 'sure, searching for restaurants now',
      reaction: null,
      effect: null,
      renameChat: null,
      rememberedUser: null,
    });

    await handler(makeSQSEvent('find me sushi in NYC'), dummyContext, () => {});

    expect(mockChat).toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      'chat_1',
      'sure, searching for restaurants now',
      undefined,
      undefined,
    );
  });
});
