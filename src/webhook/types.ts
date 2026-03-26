export interface WebhookEvent {
  event: string;
  message_id?: string;
  sender?: string;
  external_id?: string;
  text?: string;
  received_at?: number;
  attachments?: string[];
  is_group?: boolean;
  protocol?: 'imessage' | 'sms' | 'rcs' | 'non-imessage';
  timestamp?: number;
  internal_id?: string;
}

export interface MessageReceivedEvent extends WebhookEvent {
  event: 'message.received';
  message_id: string;
  sender: string;
  external_id: string;
  text: string;
  received_at: number;
  attachments: string[];
  is_group: boolean;
}

export interface TextPart {
  type: 'text';
  value: string;
}

export interface MediaPart {
  type: 'media';
  url?: string;
  mime_type?: string;
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
  return event.event === 'message.received';
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
