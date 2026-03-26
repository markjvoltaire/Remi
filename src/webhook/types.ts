// Linq Blue V3 Webhook Types
// Ref: https://apidocs.linqapp.com/webhook-events

export interface WebhookEvent {
  api_version: 'v3';
  event_id: string;
  created_at: string;
  trace_id: string;
  partner_id: string;
  event_type: string;
  data: unknown;
}

export interface MessageReceivedEvent extends WebhookEvent {
  event_type: 'message.received';
  data: MessageReceivedData;
}

/**
 * Linq webhook payloads have evolved over time. This project supports both:
 * - Legacy shape (chat_id/from/recipient_phone/message)
 * - Current shape (chat/id, sender_handle/owner_handle, parts at root)
 */
export type MessageReceivedData = MessageReceivedDataLegacy | MessageReceivedDataCurrent;

export interface MessageReceivedDataLegacy {
  chat_id: string;
  from: string;
  recipient_phone: string;
  received_at: string;
  is_from_me: boolean;
  service: 'iMessage' | 'SMS' | 'RCS';
  message: IncomingMessage;
}

export interface MessageHandle {
  handle: string;
  id: string;
  is_me: boolean;
  joined_at: string;
  left_at: string | null;
  service: 'iMessage' | 'SMS' | 'RCS';
  status: string;
}

export interface MessageChat {
  id: string;
  is_group: boolean;
  owner_handle: MessageHandle;
}

export interface MessageReceivedDataCurrent {
  chat: MessageChat;
  direction: 'inbound' | 'outbound';
  id: string;
  parts: MessagePart[];
  sender_handle: MessageHandle;
  service: 'iMessage' | 'SMS' | 'RCS';
  sent_at: string;
  effect: MessageEffect | null;
  reply_to: ReplyTo | null;
  delivered_at: string | null;
  read_at: string | null;
}

export interface IncomingMessage {
  id: string;
  parts: MessagePart[];
  effect?: MessageEffect;
  reply_to?: ReplyTo;
}

export interface TextPart {
  type: 'text';
  value: string;
}

export interface MediaPart {
  type: 'media';
  url?: string;
  attachment_id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
}

export type MessagePart = TextPart | MediaPart;

export interface MessageEffect {
  type: 'screen' | 'bubble';
  name: string;
}

export interface ReplyTo {
  message_id: string;
  part_index?: number;
}

export function isMessageReceivedEvent(event: WebhookEvent): event is MessageReceivedEvent {
  return event.event_type === 'message.received';
}

export function extractTextContent(parts: MessagePart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map(part => part.value)
    .join('\n');
}

export interface ExtractedMedia {
  url: string;
  mimeType: string;
}

export function extractImageUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('image/')
    )
    .map(part => ({ url: part.url!, mimeType: part.mime_type! }));
}

export function extractAudioUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('audio/')
    )
    .map(part => ({ url: part.url!, mimeType: part.mime_type! }));
}
