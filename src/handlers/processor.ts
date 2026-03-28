/**
 * Lambda #2 — "Processor"
 *
 * Triggered by SQS. Runs the main message processing pipeline:
 *   - Load state from DynamoDB
 *   - Claude API (tool-use loop)
 *   - Resy API calls
 *   - Send reply via Linq
 *   - Save state to DynamoDB
 *
 * Timeout: 60s (heavy Claude + Resy API calls)
 */

import type { SQSHandler, SQSRecord } from 'aws-lambda';
import type { MessageReceivedEvent } from '../webhook/types.js';
import { sendMessage, markAsRead, startTyping, sendReaction, shareContactCard, getChat, renameGroupChat } from '../blooio/client.js';
import { chat, getGroupChatAction, getTextForEffect } from '../claude/client.js';
import { getUserProfile, setUserName, addMessage } from '../state/conversation.js';
import {
  getUser, createUser, loadUserContext, consumeJustOnboarded,
  setPendingOTP, getPendingOTP, clearPendingOTP,
  setPendingChallenge, getPendingChallenge, clearPendingChallenge,
  setCredentials, clearSignedOut,
  deliverMagicLinkOnboarding,
  isMagicLinkOnboardingEnabled,
  afterResyCredentialsLinked,
} from '../auth/index.js';
import {
  sendResyOTP,
  verifyResyOTP,
  completeResyChallenge,
  registerResyUser,
  verifyPaymentStatus,
  recordPaymentSnapshotTransition,
  messageSuggestsBookingIntent,
} from '../bookings/index.js';
import { resyLinkMessages } from '../auth/resyLinkMessages.js';
import { redactPhone } from '../utils/redact.js';
import { getItem, putItem } from '../db/storage.js';

const CONTACT_CARD_INTERVAL = 5;

function cleanResponse(text: string): string {
  return text
    .replace(/\n\s*-\s*/g, ' - ')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/  +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getChatMessageCount(chatId: string): Promise<number> {
  const record = await getItem<{ count: number }>(`CHATCOUNT#${chatId}`, 'CHATCOUNT');
  return record?.count ?? 0;
}

async function setChatMessageCount(chatId: string, count: number): Promise<void> {
  await putItem(`CHATCOUNT#${chatId}`, 'CHATCOUNT', { count }, 7 * 24 * 60 * 60);
}

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error(`[processor] Error processing record:`, error);
      // Let the message go to DLQ on failure
      throw error;
    }
  }
};

async function processRecord(record: SQSRecord): Promise<void> {
  const webhookEvent = JSON.parse(record.body) as MessageReceivedEvent;
  const chatId: string | undefined = webhookEvent.external_id ?? webhookEvent.sender;
  const from: string | undefined = webhookEvent.sender;
  const messageId: string | undefined = webhookEvent.message_id;
  const service = webhookEvent.protocol === 'sms'
    ? 'SMS'
    : webhookEvent.protocol === 'rcs'
      ? 'RCS'
      : 'iMessage';
  const text = webhookEvent.text ?? '';
  const attachments = Array.isArray(webhookEvent.attachments) ? webhookEvent.attachments : [];
  const incomingEffect = undefined;
  const incomingReplyTo = undefined;

  if (!chatId || !from || !messageId) {
    console.error(`[processor] Unexpected message.received payload shape (missing required fields)`);
    return;
  }

  const images = attachments
    .filter((url): url is string => typeof url === 'string')
    .filter(url => /\.(png|jpe?g|gif|webp|heic|heif)(\?|$)/i.test(url))
    .map(url => ({ url, mimeType: 'image/*' }));
  const audio = attachments
    .filter((url): url is string => typeof url === 'string')
    .filter(url => /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(url))
    .map(url => ({ url, mimeType: 'audio/*' }));

  const start = Date.now();
  console.log(`[processor] Processing message from ${redactPhone(from)}`);

  // Track message count for this chat
  const prevCount = await getChatMessageCount(chatId);
  const count = prevCount + 1;
  await setChatMessageCount(chatId, count);

  const shouldShareContact = count === 1 || count % CONTACT_CARD_INTERVAL === 0;

  // Mark as read, start typing, get chat info, and fetch user profile in parallel
  const parallelTasks: Promise<unknown>[] = [markAsRead(chatId), startTyping(chatId), getChat(chatId), getUserProfile(from)];
  if (shouldShareContact) {
    console.log(`[processor] Sharing contact card (message #${count})`);
    parallelTasks.push(shareContactCard(chatId));
  }
  const [, , chatInfo, senderProfile] = await Promise.all(parallelTasks) as [void, void, Awaited<ReturnType<typeof getChat>>, Awaited<ReturnType<typeof getUserProfile>>];
  console.log(`[timing] parallel init: ${Date.now() - start}ms`);

  if (senderProfile?.name) {
    console.log(`[processor] Known user: ${senderProfile.name} (${senderProfile.facts.length} facts)`);
  }

  const isGroupChat = chatInfo.handles.length > 2;
  const participantNames = chatInfo.handles.map(h => h.handle);

  // ── Inline JWT auth ─────────────────────────────────────────────────
  const trimmedText = text.trim();
  if (trimmedText.startsWith('eyJ') && trimmedText.length > 100) {
    console.log(`[processor] User ${redactPhone(from)} sent a JWT token directly`);
    if (!(await getUser(from))) await createUser(from);
    await setCredentials(from, { resyAuthToken: trimmedText });
    await clearSignedOut(from);
    await clearPendingOTP(from);
    await sendMessage(chatId, resyLinkMessages.linkedFirst);
    await new Promise(resolve => setTimeout(resolve, 800));
    await sendMessage(chatId, resyLinkMessages.linkedSecond);
    await afterResyCredentialsLinked({
      phoneNumber: from,
      chatId,
      resyAuthToken: trimmedText,
      sendMessage: (c, t) => sendMessage(c, t),
    });
    return;
  }

  // ── Email / registration challenge ──────────────────────────────────
  const pendingChallenge = await getPendingChallenge(from);
  if (pendingChallenge) {
    const input = text.trim();

    // No-challenge user: just need email to try connecting
    if (pendingChallenge.isNewUser) {
      const emailMatch = input.match(/[\w.+-]+@[\w.-]+\.\w+/i);
      if (emailMatch) {
        const email = emailMatch[0].toLowerCase();
        console.log(`[processor] No-challenge user, trying with email: ${email}`);

        // Try registerResyUser (hits multiple endpoints with logging)
        const authToken = await registerResyUser(
          pendingChallenge.claimToken,
          pendingChallenge.mobileNumber,
          '',  // first_name — let Resy use existing
          '',  // last_name — let Resy use existing
          email,
        );

        if (authToken) {
          if (!(await getUser(from))) await createUser(from);
          await setCredentials(from, { resyAuthToken: authToken });
          await clearPendingChallenge(from);
          await clearSignedOut(from);
          await sendMessage(chatId, resyLinkMessages.linkedFirst);
          await new Promise(resolve => setTimeout(resolve, 800));
          await sendMessage(chatId, resyLinkMessages.linkedSecond);
          await afterResyCredentialsLinked({
            phoneNumber: from,
            chatId,
            resyAuthToken: authToken,
            sendMessage: (c, t) => sendMessage(c, t),
          });
          return;
        } else {
          await clearPendingChallenge(from);
          await sendMessage(chatId, resyLinkMessages.manualConnectFirst);
          await new Promise(resolve => setTimeout(resolve, 600));
          await sendMessage(chatId, resyLinkMessages.manualConnectSecond);
          return;
        }
      }
      await sendMessage(chatId, resyLinkMessages.emailAskNew);
      return;
    }

    // Existing user challenge: just need email
    const emailInput = input.toLowerCase();
    if (emailInput.includes('@') && emailInput.includes('.')) {
      const fieldValues: Record<string, string> = {};
      for (const field of pendingChallenge.requiredFields) {
        if (field.type === 'email' || field.name === 'em_address') {
          fieldValues[field.name] = emailInput;
        }
      }

      const authToken = await completeResyChallenge(
        {
          claimToken: pendingChallenge.claimToken,
          challengeId: pendingChallenge.challengeId,
          mobileNumber: pendingChallenge.mobileNumber,
          firstName: pendingChallenge.firstName,
          isNewUser: false,
          requiredFields: pendingChallenge.requiredFields,
        },
        fieldValues,
      );

      if (authToken) {
        if (!(await getUser(from))) await createUser(from);
        await setCredentials(from, { resyAuthToken: authToken });
        await clearPendingChallenge(from);
        await clearSignedOut(from);
        await sendMessage(chatId, resyLinkMessages.linkedFirst);
        await new Promise(resolve => setTimeout(resolve, 800));
        await sendMessage(chatId, resyLinkMessages.linkedSecond);
        await afterResyCredentialsLinked({
          phoneNumber: from,
          chatId,
          resyAuthToken: authToken,
          sendMessage: (c, t) => sendMessage(c, t),
        });
        return;
      } else {
        await sendMessage(chatId, resyLinkMessages.emailMismatch);
        return;
      }
    }
    await sendMessage(chatId, resyLinkMessages.emailReminder);
    return;
  }

  // ── OTP code check ──────────────────────────────────────────────────
  const pendingOtp = await getPendingOTP(from);
  if (pendingOtp) {
    const stripped = text.trim().replace(/[\s\-\.]/g, '');
    if (/^\d{4,6}$/.test(stripped)) {
      const result = await verifyResyOTP(from, stripped);

      if (!result) {
        await sendMessage(chatId, resyLinkMessages.otpBad);
        return;
      }

      if ('error' in result) {
        console.error(`[processor] Resy server error verifying OTP for ${redactPhone(from)}`);
        await sendMessage(chatId, resyLinkMessages.otpServerBusy);
        await new Promise(resolve => setTimeout(resolve, 2000));
        const retry = await sendResyOTP(from);
        if (retry === 'sms') {
          await setPendingOTP(from, chatId);
          await sendMessage(chatId, resyLinkMessages.otpResent);
        }
        return;
      }

      if ('token' in result) {
        if (!(await getUser(from))) await createUser(from);
        await setCredentials(from, { resyAuthToken: result.token });
        await clearPendingOTP(from);
        await clearSignedOut(from);
        await sendMessage(chatId, resyLinkMessages.linkedFirst);
        await new Promise(resolve => setTimeout(resolve, 800));
        await sendMessage(chatId, resyLinkMessages.linkedSecond);
        await afterResyCredentialsLinked({
          phoneNumber: from,
          chatId,
          resyAuthToken: result.token,
          sendMessage: (c, t) => sendMessage(c, t),
        });
        return;
      }

      const challenge = result.challenge;
      await clearPendingOTP(from);
      await setPendingChallenge(from, {
        chatId,
        claimToken: challenge.claimToken,
        challengeId: challenge.challengeId,
        mobileNumber: challenge.mobileNumber,
        firstName: challenge.firstName,
        isNewUser: challenge.isNewUser,
        requiredFields: challenge.requiredFields,
      });

      if (challenge.isNewUser) {
        await sendMessage(chatId, resyLinkMessages.emailAskNew);
      } else {
        await sendMessage(chatId, resyLinkMessages.emailAskExisting(challenge.firstName));
      }
      return;
    }
    await sendMessage(chatId, resyLinkMessages.otpWaiting);
    return;
  }

  // ── Auth check ──────────────────────────────────────────────────────
  const userCtx = await loadUserContext(from);
  if (!userCtx) {
    if (!(await getUser(from))) {
      await createUser(from);
      console.log(`[processor] New user: ${redactPhone(from)}`);
    }

    const inbound = text.trim();
    if (inbound) {
      await addMessage(chatId, 'user', inbound, from);
    }

    if (isMagicLinkOnboardingEnabled()) {
      const magicOk = await deliverMagicLinkOnboarding(chatId, from, msg => sendMessage(chatId, msg));
      if (magicOk) {
        console.log(`[processor] Sent magic link onboarding to ${redactPhone(from)}`);
        return;
      }
      console.warn(`[processor] Magic link failed — falling back to SMS OTP for ${redactPhone(from)}`);
    }

    const otpResult = await sendResyOTP(from);
    if (otpResult === 'sms') {
      await setPendingOTP(from, chatId);
      await sendMessage(chatId, resyLinkMessages.otpSentFirst);
      await new Promise(resolve => setTimeout(resolve, 600));
      await sendMessage(chatId, resyLinkMessages.otpSentSecond);
    } else if (otpResult === 'rate_limited') {
      await sendMessage(chatId, resyLinkMessages.rateLimitedFirst);
      await new Promise(resolve => setTimeout(resolve, 600));
      await sendMessage(chatId, resyLinkMessages.rateLimitedSecond);
    } else {
      await sendMessage(chatId, resyLinkMessages.otpSendFailedFirst);
      await new Promise(resolve => setTimeout(resolve, 600));
      await sendMessage(chatId, resyLinkMessages.otpSendFailedSecond);
    }
    return;
  }

  // ── Group chat classifier ───────────────────────────────────────────
  if (isGroupChat && audio.length === 0 && images.length === 0) {
    const { action, reaction: quickReaction } = await getGroupChatAction(text, from, chatId);

    if (action === 'ignore') {
      console.log(`[processor] Ignoring group chat message`);
      return;
    }

    if (action === 'react') {
      if (quickReaction) {
        await sendReaction(messageId, quickReaction);
        await addMessage(chatId, 'user', text, from);
        const reactionDisplay = quickReaction.type === 'custom' ? (quickReaction as { type: 'custom'; emoji: string }).emoji : quickReaction.type;
        await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);
      }
      return;
    }
  }

  // ── Main Claude response ────────────────────────────────────────────
  const justOnboarded = await consumeJustOnboarded(from);

  let hasPaymentMethod: boolean | undefined;
  let paymentBecameAvailable = false;
  const resyToken = userCtx.bookingsCredentials?.resyAuthToken;
  if (resyToken && messageSuggestsBookingIntent(text)) {
    try {
      const payStatus = await verifyPaymentStatus(resyToken);
      const snap = recordPaymentSnapshotTransition(from, payStatus);
      hasPaymentMethod = payStatus.hasPaymentMethod;
      paymentBecameAvailable = snap.paymentBecameAvailable;
    } catch (err) {
      console.warn(`[processor] verifyPaymentStatus failed (non-fatal): ${err}`);
    }
  }

  const { text: responseText, reaction, effect, renameChat, rememberedUser } = await chat(chatId, text, images, audio, {
    isGroupChat,
    participantNames,
    chatName: chatInfo.display_name,
    incomingEffect,
    senderHandle: from,
    senderProfile,
    service,
    bookingsCredentials: userCtx.bookingsCredentials,
    justOnboarded,
    hasPaymentMethod,
    paymentBecameAvailable,
  });
  console.log(`[timing] claude: ${Date.now() - start}ms`);

  if (reaction) {
    await sendReaction(messageId, reaction);
  }

  if (renameChat && isGroupChat) {
    await renameGroupChat(chatId, renameChat);
  }

  let finalText = responseText;
  if (!finalText && effect) {
    finalText = await getTextForEffect(effect.name);
  }
  if (!finalText && renameChat && isGroupChat) {
    finalText = `renamed the chat to "${renameChat}" 😎`;
  }

  if (finalText) {
    const messages = finalText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0);
    const replyTo = incomingReplyTo ? { message_id: messageId } : undefined;

    for (let i = 0; i < messages.length; i++) {
      const isLastMessage = i === messages.length - 1;
      const messageEffect = isLastMessage ? effect ?? undefined : undefined;
      const messageReplyTo = (i === 0) ? replyTo : undefined;

      await sendMessage(chatId, messages[i], messageEffect, messageReplyTo);

      if (!isLastMessage) {
        const delay = 400 + Math.random() * 400;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.log(`[processor] Done for ${redactPhone(from)} (${Date.now() - start}ms)`);
}
