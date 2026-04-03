import crypto from 'node:crypto';

const BASE_URL = 'https://backend.blooio.com/v2/api';
const API_KEY = process.env.BLOOIO_API_KEY;
const FIVE_MINUTES_SECONDS = 5 * 60;

function truncateError(text: string, maxLen = 140): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export interface ChatHandle {
  handle: string;
  service: string;
}

export interface ChatInfo {
  id: string;
  display_name: string | null;
  handles: ChatHandle[];
  is_group: boolean;
  service: string;
}

export type ScreenEffect =
  | 'confetti'
  | 'fireworks'
  | 'lasers'
  | 'sparkles'
  | 'celebration'
  | 'hearts'
  | 'love'
  | 'balloons'
  | 'happy_birthday'
  | 'echo'
  | 'spotlight';
export type BubbleEffect = 'slam' | 'loud' | 'gentle' | 'invisible_ink';
export type MessageEffect = { type: 'screen' | 'bubble'; name: string };
export type ReplyTo = { message_id: string; part_index?: number };

export interface SendMessageResponse {
  chat_id: string;
  message: {
    id: string;
    parts: Array<{ type: string; value?: string }>;
    sent_at: string;
    delivery_status: 'pending' | 'queued' | 'sent' | 'delivered' | 'failed';
    is_read: boolean;
  };
}

export interface MediaAttachment {
  url: string;
}

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';
export type Reaction =
  | { type: StandardReactionType }
  | { type: 'custom'; emoji: string };

export interface SendReactionResponse {
  is_me: boolean;
  handle: string;
  type: ReactionType;
}

export async function sendMessage(
  chatId: string,
  text: string,
  _effect?: MessageEffect,
  _replyTo?: ReplyTo,
  _media?: MediaAttachment[],
): Promise<SendMessageResponse> {
  if (!API_KEY) {
    throw new Error('BLOOIO_API_KEY not configured');
  }

  const encodedChatId = encodeURIComponent(chatId);
  const url = `${BASE_URL}/chats/${encodedChatId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Blooio API error: ${response.status} ${truncateError(errorText)}`);
  }

  const data = await response.json() as { message_id?: string; status?: string };
  return {
    chat_id: chatId,
    message: {
      id: data.message_id ?? `msg_${Date.now()}`,
      parts: [{ type: 'text', value: text }],
      sent_at: new Date().toISOString(),
      delivery_status: (data.status as SendMessageResponse['message']['delivery_status']) ?? 'queued',
      is_read: false,
    },
  };
}

export async function getChat(chatId: string): Promise<ChatInfo> {
  const botNumber = process.env.BLOOIO_PHONE_NUMBER;
  const handles: ChatHandle[] = [{ handle: chatId, service: 'iMessage' }];
  if (botNumber) {
    handles.push({ handle: botNumber, service: 'iMessage' });
  }
  return {
    id: chatId,
    display_name: null,
    handles,
    is_group: false,
    service: 'iMessage',
  };
}

export async function renameGroupChat(_chatId: string, _displayName: string): Promise<void> {}
export async function setGroupChatIcon(_chatId: string, _iconUrl: string): Promise<void> {}
export async function shareContactCard(_chatId: string): Promise<void> {}
export async function markAsRead(chatId: string): Promise<void> {
  if (!API_KEY) {
    throw new Error('BLOOIO_API_KEY not configured');
  }

  const encodedChatId = encodeURIComponent(chatId);
  const url = `${BASE_URL}/chats/${encodedChatId}/read`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Blooio API error: ${response.status} ${truncateError(errorText)}`);
  }
}
export async function startTyping(_chatId: string): Promise<void> {}
export async function stopTyping(_chatId: string): Promise<void> {}
export async function sendReaction(
  _messageId: string,
  reaction: Reaction,
  _operation: 'add' | 'remove' = 'add',
): Promise<SendReactionResponse> {
  return {
    is_me: true,
    handle: process.env.BLOOIO_PHONE_NUMBER || 'bot',
    type: reaction.type,
  };
}

export type WebhookSignatureResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies Blooio webhook HMAC. Use `reason` when ok is false — common fixes:
 * set BLOOIO_WEBHOOK_SECRET on Render to match Blooio Dashboard → Webhooks, or rotate secret on both sides.
 */
export function checkWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): WebhookSignatureResult {
  const secret = process.env.BLOOIO_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return {
      ok: false,
      reason:
        'BLOOIO_WEBHOOK_SECRET is unset — add the webhook signing secret from Blooio Dashboard → Webhooks to Render env.',
    };
  }
  if (!signatureHeader?.trim()) {
    return { ok: false, reason: 'Missing X-Blooio-Signature header (request did not come from Blooio or proxy stripped headers).' };
  }

  const parts = signatureHeader.split(',');
  const tsPart = parts.find(p => p.startsWith('t='));
  const sigPart = parts.find(p => p.startsWith('v1='));
  if (!tsPart || !sigPart) {
    return { ok: false, reason: 'Malformed X-Blooio-Signature (expected t=...,v1=...).' };
  }

  const timestamp = tsPart.slice(2);
  const signature = sigPart.slice(3);
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]+$/i.test(signature)) {
    return { ok: false, reason: 'Invalid timestamp or signature hex in X-Blooio-Signature.' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const age = Math.abs(nowSeconds - Number(timestamp));
  if (age > FIVE_MINUTES_SECONDS) {
    return {
      ok: false,
      reason: `Signature timestamp skew too large (${age}s > ${FIVE_MINUTES_SECONDS}s) — check server clock or replayed payload.`,
    };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (sigBuffer.length !== expectedBuffer.length) {
    return {
      ok: false,
      reason:
        'Signature length mismatch — BLOOIO_WEBHOOK_SECRET does not match Blooio (rotate in dashboard and paste new value into Render).',
    };
  }

  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return {
      ok: false,
      reason:
        'Signature mismatch — wrong webhook secret or body was altered (Blooio signs exact raw JSON bytes).',
    };
  }

  return { ok: true };
}

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  return checkWebhookSignature(rawBody, signatureHeader).ok;
}
