import { Request, Response } from 'express';
import {
  WebhookEvent,
  isMessageReceivedEvent,
  isMessageReadEvent,
  ExtractedMedia,
  MessageEffect,
  ReplyTo,
} from './types.js';
import { redactPhone } from '../utils/redact.js';
import { verifyWebhookSignature } from '../blooio/client.js';

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface MessageHandler {
  (chatId: string, from: string, text: string, messageId: string, images: ExtractedMedia[], audio: ExtractedMedia[], incomingEffect?: MessageEffect, incomingReplyTo?: ReplyTo, service?: MessageService): Promise<void>;
}

export function createWebhookHandler(onMessage: MessageHandler) {
  const botNumber = process.env.BLOOIO_PHONE_NUMBER?.trim();
  // Sender numbers to ignore (comma-separated)
  const ignoredSenders = process.env.IGNORED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
  // If set, ONLY respond to these sender numbers (for local dev)
  const allowedSenders = process.env.ALLOWED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];

  return async (req: Request, res: Response) => {
    const rawBody = ((req as Request & { rawBody?: string }).rawBody) ?? JSON.stringify(req.body ?? {});
    const signatureHeader = req.get('X-Blooio-Signature');
    if (!verifyWebhookSignature(rawBody, signatureHeader)) {
      console.error('[webhook] Invalid Blooio signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const event = req.body as WebhookEvent;

    const pstTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    console.log(`[webhook] ${pstTime} PST | ${event.event} (${event.message_id ?? 'n/a'})`);

    // Acknowledge receipt immediately
    res.status(200).json({ received: true });

    // Process message.received events
    if (isMessageReceivedEvent(event)) {
      // Debug: log full webhook payload (only in development)
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[webhook] Full payload:`, JSON.stringify(event, null, 2));
      }

      const chatId: string | undefined = event.external_id ?? event.sender;
      const from: string | undefined = event.sender;
      const recipientPhone: string | undefined = event.internal_id;
      const messageId: string | undefined = event.message_id;
      const text = event.text ?? '';
      const attachments = Array.isArray(event.attachments) ? event.attachments : [];
      const service: MessageService | undefined = event.protocol === 'sms'
        ? 'SMS'
        : event.protocol === 'rcs'
          ? 'RCS'
          : 'iMessage';

      if (!chatId || !from || !recipientPhone || !messageId) {
        console.error(`[webhook] Unexpected message.received payload shape (missing required fields)`);
        return;
      }

      // Only process messages sent to this bot's phone number
      if (botNumber && recipientPhone !== botNumber) {
        console.log(`[webhook] Skipping message to ${redactPhone(recipientPhone)} (not this bot's number)`);
        return;
      }
      if (botNumber && from === botNumber) {
        console.log('[webhook] Skipping own message');
        return;
      }

      // If ALLOWED_SENDERS is set, only respond to those numbers
      if (allowedSenders.length > 0 && !allowedSenders.includes(from)) {
        console.log(`[webhook] Skipping ${redactPhone(from)} (not in allowed senders)`);
        return;
      }

      // Skip messages from ignored senders
      if (ignoredSenders.includes(from)) {
        console.log(`[webhook] Skipping ${redactPhone(from)} (ignored sender)`);
        return;
      }

      const images: ExtractedMedia[] = attachments
        .filter((url): url is string => typeof url === 'string')
        .filter(url => /\.(png|jpe?g|gif|webp|heic|heif)(\?|$)/i.test(url))
        .map(url => ({ url, mimeType: 'image/*' }));
      const audio: ExtractedMedia[] = attachments
        .filter((url): url is string => typeof url === 'string')
        .filter(url => /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(url))
        .map(url => ({ url, mimeType: 'audio/*' }));
      const incomingEffect = undefined as MessageEffect | undefined;
      const incomingReplyTo = undefined as ReplyTo | undefined;

      if (!text.trim() && images.length === 0 && audio.length === 0) {
        console.log(`[webhook] Skipping empty message`);
        return;
      }

      const effectInfo = incomingEffect ? ` [effect: ${incomingEffect.type}/${incomingEffect.name}]` : '';
      const replyInfo = incomingReplyTo ? ` [reply to: ${incomingReplyTo.message_id.slice(0, 8)}...]` : '';
      const mediaInfo = [
        images.length > 0 ? `${images.length} image(s)` : '',
        audio.length > 0 ? `${audio.length} audio` : '',
      ].filter(Boolean).join(', ');
      console.log(`[webhook] Message from ${redactPhone(from)}: "${text.substring(0, 50)}..."${mediaInfo ? ` [${mediaInfo}]` : ''}${effectInfo}${replyInfo}`);

      try {
        await onMessage(chatId, from, text, messageId, images, audio, incomingEffect ?? undefined, incomingReplyTo ?? undefined, service);
      } catch (error) {
        console.error(`[webhook] Error handling message:`, error);
      }
    }

    if (isMessageReadEvent(event)) {
      const chatId = event.external_id ?? 'unknown-chat';
      const messageId = event.message_id ?? 'unknown-message';
      const readAt = event.read_at ? new Date(event.read_at).toISOString() : 'unknown-time';
      console.log(`[webhook] Read receipt: chat=${chatId} message=${messageId} at=${readAt}`);
    }
  };
}
