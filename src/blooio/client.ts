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
export async function markAsRead(_chatId: string): Promise<void> {}
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

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = process.env.BLOOIO_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) {
    return false;
  }

  const parts = signatureHeader.split(',');
  const tsPart = parts.find(p => p.startsWith('t='));
  const sigPart = parts.find(p => p.startsWith('v1='));
  if (!tsPart || !sigPart) {
    return false;
  }

  const timestamp = tsPart.slice(2);
  const signature = sigPart.slice(3);
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]+$/i.test(signature)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const age = Math.abs(nowSeconds - Number(timestamp));
  if (age > FIVE_MINUTES_SECONDS) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}
