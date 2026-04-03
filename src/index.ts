import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { createWebhookHandler } from './webhook/handler.js';
import { sendMessage, markAsRead, startTyping, sendReaction, shareContactCard, getChat, renameGroupChat } from './blooio/client.js';
import { chat, getGroupChatAction, getTextForEffect } from './claude/client.js';
import { getUserProfile, addMessage, setUserName, addUserFact } from './state/conversation.js';
import {
  authRoutes,
  getUser,
  createUser,
  loadUserContext,
  consumeJustOnboarded,
  setPendingOTP,
  getPendingOTP,
  clearPendingOTP,
  setPendingChallenge,
  getPendingChallenge,
  clearPendingChallenge,
  setCredentials,
  clearSignedOut,
  getProfileOnboarding,
  setProfileOnboarding,
  afterResyCredentialsLinked,
} from './auth/index.js';
import {
  sendResyOTP,
  verifyResyOTP,
  completeResyChallenge,
  registerResyUser,
  verifyPaymentStatus,
  recordPaymentSnapshotTransition,
  messageSuggestsBookingIntent,
} from './bookings/index.js';
import { resyLinkMessages } from './auth/resyLinkMessages.js';
import { redactPhone } from './utils/redact.js';
import { putItem } from './db/storage.js';

// Clean up LLM response formatting quirks before sending
function cleanResponse(text: string): string {
  return text
    // Turn newline-dash into inline dash (e.g., "foo\n - bar" → "foo - bar")
    .replace(/\n\s*-\s*/g, ' - ')
    // Remove markdown underlines/italics (_text_ → text)
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    // Remove markdown bold (**text** → text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove stray asterisks used for emphasis
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    // Clean up multiple spaces
    .replace(/  +/g, ' ')
    // Clean up extra newlines (but preserve intentional double-newlines for --- splits)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeOnboardingAnswer(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

// Track message count per chat for contact card sharing (DynamoDB-backed)
const CONTACT_CARD_INTERVAL = 5; // Share every N messages

async function getChatMessageCount(chatId: string): Promise<number> {
  const { getItem } = await import('./db/storage.js');
  const record = await getItem<{ count: number }>(`CHATCOUNT#${chatId}`, 'CHATCOUNT');
  return record?.count ?? 0;
}

async function setChatMessageCount(chatId: string, count: number): Promise<void> {
  await putItem(`CHATCOUNT#${chatId}`, 'CHATCOUNT', { count }, 7 * 24 * 60 * 60); // 7 day TTL
}

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies (cap at 50KB to prevent abuse — PEM keys are ~2KB)
app.use(express.json({
  limit: '50kb',
  verify: (req, _res, buf) => {
    (req as { rawBody?: string }).rawBody = buf.toString('utf8');
  },
}));

// Security headers on all responses
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// HTTPS enforcement in production (behind proxy like Railway/ngrok)
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') {
      res.redirect(301, `https://${req.headers.host}${req.url}`);
      return;
    }
    next();
  });
}

// Serve static assets (fonts, images) — public/ lives at project root
app.use(express.static(path.join(process.cwd(), 'public')));

// Auth routes (onboarding page + credential submission)
app.use(authRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook endpoint for Blooio
app.post(
  '/blooio-webhook',
  createWebhookHandler(async (chatId, from, text, messageId, images, audio, incomingEffect, incomingReplyTo, service) => {
    const start = Date.now();
    console.log(`[main] Processing message from ${redactPhone(from)}`);

    // Track message count for this chat
    const prevCount = await getChatMessageCount(chatId);
    const count = prevCount + 1;
    await setChatMessageCount(chatId, count);

    // Share contact card on first message or every N messages
    const shouldShareContact = count === 1 || count % CONTACT_CARD_INTERVAL === 0;

    // Mark as read, start typing, get chat info, and fetch user profile in parallel
    const parallelTasks: Promise<unknown>[] = [markAsRead(chatId), startTyping(chatId), getChat(chatId), getUserProfile(from)];
    if (shouldShareContact) {
      console.log(`[main] Sharing contact card (message #${count})`);
      parallelTasks.push(shareContactCard(chatId));
    }
    const [, , chatInfo, senderProfile] = await Promise.all(parallelTasks) as [void, void, Awaited<ReturnType<typeof getChat>>, Awaited<ReturnType<typeof getUserProfile>>];
    console.log(`[timing] markAsRead+startTyping+getChat+getProfile${shouldShareContact ? '+shareContact' : ''}: ${Date.now() - start}ms`);
    if (senderProfile?.name) {
      console.log(`[main] Known user: ${senderProfile.name} (${senderProfile.facts.length} facts)`);
    }

    // Determine if this is a group chat (more than 2 participants)
    const isGroupChat = chatInfo.handles.length > 2;
    const participantNames = chatInfo.handles.map(h => h.handle);

    // ── Profile onboarding (name/city/neighborhood/dietary) ───────────────
    // Run this before Resy OTP auth flow so first-time users get a conversational intro.
    const user = await getUser(from);
    let onboarding = await getProfileOnboarding(from);

    if (!onboarding) {
      if (!user) {
        await createUser(from);
      }
      await setProfileOnboarding(from, { stage: 'ask_name', completed: false });
      await sendMessage(chatId, `hey. im remi — a personal concierge by text.`);
      await new Promise(resolve => setTimeout(resolve, 500));
      await sendMessage(chatId, `whats your name?`);
      return;
    }

    if (!onboarding.completed) {
      const answer = normalizeOnboardingAnswer(text);
      if (!answer) {
        await sendMessage(chatId, `sorry, i missed that — can you send that again?`);
        return;
      }

      if (onboarding.stage === 'ask_name') {
        await setUserName(from, answer);
        await setProfileOnboarding(from, { stage: 'ask_city', name: answer, completed: false });
        await sendMessage(chatId, `good to meet you ${answer}.`);
        await new Promise(resolve => setTimeout(resolve, 500));
        await sendMessage(chatId, `what city are you in?`);
        return;
      }

      if (onboarding.stage === 'ask_city') {
        await addUserFact(from, `City: ${answer}`);
        await setProfileOnboarding(from, { stage: 'ask_diet', city: answer, completed: false });
        await sendMessage(chatId, `any food you dont eat?`);
        return;
      }

      // Backward compatibility: users who were already in the old flow.
      if (onboarding.stage === 'ask_neighborhood') {
        await setProfileOnboarding(from, { stage: 'ask_diet', completed: false });
        await sendMessage(chatId, `any food you dont eat?`);
        return;
      }

      if (onboarding.stage === 'ask_diet') {
        const normalized = answer.toLowerCase();
        const dietaryFact = /not really|none|nope|anything|no\b/.test(normalized)
          ? 'Dietary restrictions: none'
          : `Dietary restrictions: ${answer}`;
        await addUserFact(from, dietaryFact);
        await setProfileOnboarding(from, { stage: 'complete', dietary: answer, completed: true });
        await sendMessage(chatId, `youre all set.`);
        await new Promise(resolve => setTimeout(resolve, 500));
        await sendMessage(chatId, `just tell me what you need.`);
        return;
      }
    }

    // ── Inline JWT auth: user texts their Resy token directly ─────────────
    const trimmedText = text.trim();
    if (trimmedText.startsWith('eyJ') && trimmedText.length > 100) {
      console.log(`[main] User ${redactPhone(from)} sent a JWT token directly`);
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
      console.log(`[main] JWT stored for ${redactPhone(from)}`);
      return;
    }

    // ── Email challenge: user needs to verify email after OTP code ────────
    const pendingChallenge = await getPendingChallenge(from);
    if (pendingChallenge) {
      const input = text.trim();

      if (pendingChallenge.isNewUser) {
        const emailMatch = input.match(/[\w.+-]+@[\w.-]+\.\w+/i);
        if (emailMatch) {
          const email = emailMatch[0].toLowerCase();
          console.log(`[main] No-challenge user, trying with email: ${email}`);

          const authToken = await registerResyUser(
            pendingChallenge.claimToken,
            pendingChallenge.mobileNumber,
            '',
            '',
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
            console.log(`[main] Challenge completed — credentials stored for ${redactPhone(from)}`);
            return;
          }

          await clearPendingChallenge(from);
          await sendMessage(chatId, resyLinkMessages.manualConnectFirst);
          await new Promise(resolve => setTimeout(resolve, 600));
          await sendMessage(chatId, resyLinkMessages.manualConnectSecond);
          return;
        }

        await sendMessage(chatId, resyLinkMessages.emailAskNew);
        return;
      }

      const emailInput = input.toLowerCase();
      if (emailInput.includes('@') && emailInput.includes('.')) {
        console.log(`[main] User ${redactPhone(from)} sent email for challenge verification`);

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
            isNewUser: pendingChallenge.isNewUser,
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
          console.log(`[main] Challenge completed — credentials stored for ${redactPhone(from)}`);
          return;
        }

        await sendMessage(chatId, resyLinkMessages.emailMismatch);
        console.log(`[main] Challenge verification failed for ${redactPhone(from)}`);
        return;
      }

      await sendMessage(chatId, resyLinkMessages.emailReminder);
      return;
    }

    // ── OTP code check: if user is mid-onboarding and sends a code ────────
    const pendingOtp = await getPendingOTP(from);
    if (pendingOtp) {
      // Strip dashes, spaces, dots from input (users may type "322-311" or "322 311")
      const stripped = text.trim().replace(/[\s\-\.]/g, '');
      // Accept 4-6 digit codes
      if (/^\d{4,6}$/.test(stripped)) {
        console.log(`[main] User ${redactPhone(from)} sent OTP code, verifying...`);
        const result = await verifyResyOTP(from, stripped);

        if (!result) {
          await sendMessage(chatId, resyLinkMessages.otpBad);
          console.log(`[main] OTP verification failed for ${redactPhone(from)}`);
          return;
        }

        if ('token' in result) {
          // Direct token — rare but possible
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
          console.log(`[main] OTP verified (direct token) — credentials stored for ${redactPhone(from)}`);
          return;
        }

        if ('error' in result) {
          await sendMessage(chatId, resyLinkMessages.otpServerBusy);
          await new Promise(resolve => setTimeout(resolve, 2000));
          const retry = await sendResyOTP(from);
          if (retry === 'sms') {
            await setPendingOTP(from, chatId);
            await sendMessage(chatId, resyLinkMessages.otpResent);
          }
          console.log(`[main] OTP verification returned server error`);
          return;
        }

        if (!('challenge' in result)) {
          await sendMessage(chatId, resyLinkMessages.otpServerBusy);
          return;
        }

        // Challenge — need email verification
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
        console.log(`[main] OTP accepted, challenge pending (needs email) for ${redactPhone(from)}`);
        return;
      }
      // User sent non-code text while OTP is pending — remind them
      await sendMessage(chatId, resyLinkMessages.otpWaiting);
      return;
    }

    // ── Auth check ────────────────────────────────────────────────────────
    // With house account fallback, loadUserContext returns null ONLY when
    // RESY_AUTH_TOKEN is unset AND the user has no personal credentials.
    const userCtx = await loadUserContext(from);
    if (!userCtx) {
      // No house account configured and no personal credentials — cannot book
      if (!(await getUser(from))) {
        await createUser(from);
        console.log(`[main] New user (no house account available): ${redactPhone(from)}`);
      }
      await sendMessage(chatId, `hey, i'm having trouble connecting to our reservation system right now. sit tight — i'll sort it out.`);
      console.log(`[main] No Resy credentials and no house account for ${redactPhone(from)}`);
      return;
    }

    // ── Opt-in Resy account linking ─────────────────────────────────────
    // Users on the house account can explicitly link their own Resy account
    const wantsToLink = /\b(link|connect|pair|attach)\b.*\b(resy|account|reservation)\b/i.test(text)
      || /\b(resy|account|reservation)\b.*\b(link|connect|pair|attach)\b/i.test(text);

    if (wantsToLink && userCtx.isHouseAccount) {
      const otpResult = await sendResyOTP(from);
      if (otpResult === 'sms') {
        await setPendingOTP(from, chatId);
        await sendMessage(chatId, resyLinkMessages.otpSentFirst);
        await new Promise(resolve => setTimeout(resolve, 600));
        await sendMessage(chatId, resyLinkMessages.otpSentSecond);
        console.log(`[main] User requested Resy link — sent OTP to ${redactPhone(from)}`);
      } else if (otpResult === 'rate_limited') {
        await sendMessage(chatId, `verification texts are limited right now — try again in a few minutes.`);
      } else {
        await sendMessage(chatId, `i couldn't send a verification code to this number. you can still book through me — i'll handle everything.`);
      }
      return;
    }

    // In group chats, check if Claude should respond, react, or ignore
    // Always respond to voice memos/images - someone sending media is clearly trying to communicate
    if (isGroupChat && audio.length === 0 && images.length === 0) {
      const { action, reaction: quickReaction } = await getGroupChatAction(text, from, chatId);

      if (action === 'ignore') {
        console.log(`[main] Ignoring group chat message`);
        return;
      }

      if (action === 'react') {
        // Just send a reaction, no full response needed
        if (quickReaction) {
          await sendReaction(messageId, quickReaction);
          console.log(`[timing] quick reaction: ${Date.now() - start}ms`);

          // Save to conversation history so Claude knows what happened (include sender for group chats)
          await addMessage(chatId, 'user', text, from);
          const reactionDisplay = quickReaction.type === 'custom' ? (quickReaction as { type: 'custom'; emoji: string }).emoji : quickReaction.type;
          await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);

          console.log(`[main] Reacted to ${redactPhone(from)} with ${reactionDisplay}`);
        }
        return;
      }

      console.log(`[main] Claude should respond to this group message`);
    } else if (isGroupChat) {
      console.log(`[main] Responding to group media (skipping classifier)`);
    }

    // Check if user just completed onboarding (one-shot flag)
    const justOnboarded = await consumeJustOnboarded(from);
    if (justOnboarded) {
      console.log(`[main] User ${redactPhone(from)} just completed onboarding — injecting context`);
    }

    let hasPaymentMethod: boolean | undefined;
    let paymentBecameAvailable = false;
    const resyToken = userCtx.bookingsCredentials?.resyAuthToken;
    // Only check per-user payment status for linked accounts (house account has its own card)
    if (resyToken && !userCtx.isHouseAccount && messageSuggestsBookingIntent(text)) {
      try {
        const payStatus = await verifyPaymentStatus(resyToken);
        const snap = recordPaymentSnapshotTransition(from, payStatus);
        hasPaymentMethod = payStatus.hasPaymentMethod;
        paymentBecameAvailable = snap.paymentBecameAvailable;
      } catch (err) {
        console.warn(`[main] verifyPaymentStatus failed (non-fatal): ${err}`);
      }
    }

    // Get Claude's response (typing indicator shows while this runs)
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
      isHouseAccount: userCtx.isHouseAccount,
    });
    console.log(`[timing] claude: ${Date.now() - start}ms`);
    console.log(`[debug] responseText: ${responseText ? `"${responseText.substring(0, 50)}..."` : 'null'}, effect: ${effect ? JSON.stringify(effect) : 'null'}, renameChat: ${renameChat || 'null'}`);

    // Send reaction if Claude wants to
    if (reaction) {
      await sendReaction(messageId, reaction);
      console.log(`[timing] reaction: ${Date.now() - start}ms`);
    }

    // Rename group chat if Claude wants to
    if (renameChat && isGroupChat) {
      await renameGroupChat(chatId, renameChat);
      console.log(`[timing] renameChat: ${Date.now() - start}ms`);
    }

    // Send text response if there is one (with optional effect)
    // If Claude chose an effect but no text, get text from Haiku
    let finalText = responseText;
    if (!finalText && effect) {
      console.log(`[main] Claude sent effect without text, getting message from Haiku...`);
      finalText = await getTextForEffect(effect.name);
      console.log(`[timing] effect text followup: ${Date.now() - start}ms`);
    }

    // If Claude renamed chat but didn't send text, add a simple acknowledgment (group chats only)
    if (!finalText && renameChat && isGroupChat) {
      console.log(`[main] Claude renamed chat without text, adding acknowledgment`);
      finalText = `renamed the chat to "${renameChat}" 😎`;
    }

    // If Claude used remember_user without text, just log it - no automatic acknowledgments
    // Claude should write its own response if it wants to acknowledge learning something
    if (!finalText && rememberedUser) {
      console.log(`[main] Claude saved user info without text response (no auto-ack)`);
    }

    // Avoid silent no-op: if Claude produced no text, send a fallback
    // In DMs, reaction-only is not enough — always include a text reply
    if (!finalText && (!reaction || !isGroupChat)) {
      finalText = `hey — i'm here. what are you trying to book? (city, date, party size)`;
      console.log(`[main] Claude returned no text${reaction ? ' (reaction-only in DM)' : ''}; sending fallback`);
    }

    if (finalText) {
      // Split into multiple messages first, then clean each one
      // (must split before cleaning, or the --- delimiter gets mangled)
      const messages = finalText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0);

      // If the incoming message was a reply, continue the thread by replying to that message
      const replyTo = incomingReplyTo ? { message_id: messageId } : undefined;

      if (messages.length > 0) {
        for (let i = 0; i < messages.length; i++) {
          const isLastMessage = i === messages.length - 1;
          const messageEffect = isLastMessage ? effect ?? undefined : undefined;
          const messageReplyTo = (i === 0) ? replyTo : undefined;

          const sent = await sendMessage(chatId, messages[i], messageEffect, messageReplyTo);
          console.log(`[linq] delivery_status=${sent.message.delivery_status}`);

          // Add a natural delay between messages (except after the last one)
          if (!isLastMessage) {
            const delay = 400 + Math.random() * 400; // 400-800ms feels natural
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        console.log(`[timing] sendMessage (${messages.length} text msg${messages.length !== 1 ? 's' : ''}): ${Date.now() - start}ms`);
      }

      const extras = [effect && 'effect', replyTo && 'thread'].filter(Boolean).join(', ');
      console.log(`[timing] total: ${Date.now() - start}ms (${extras || 'text only'})`);
    } else if (reaction) {
      // Reaction-only response - already saved to conversation history by chat()
      console.log(`[main] Reaction-only response (saved to history for context)`);
    }

    console.log(`[main] Reply sent to ${redactPhone(from)}`);
  })
);

// Only start Express server when NOT running inside Lambda
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║             Blooio Bookings Agent                     ║
╠═══════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}              ║
║                                                       ║
║  Endpoints:                                           ║
║    POST /blooio-webhook - Blooio webhook receiver     ║
║    GET  /health        - Health check                 ║
║    GET  /auth/setup    - Onboarding page              ║
║                                                       ║
║  Next steps:                                          ║
║    1. Run: ngrok http ${PORT}                            ║
║    2. Configure webhook URL in Blooio                 ║
║    3. Text your Blooio number!                        ║
╚═══════════════════════════════════════════════════════╝
    `);
  });
}

// Export for Lambda handler usage
export { app };
