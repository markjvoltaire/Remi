import Anthropic from '@anthropic-ai/sdk';
import { getConversation, addMessage, clearConversation, getUserProfile, setUserName, addUserFact, clearUserProfile, UserProfile, StoredMessage } from '../state/conversation.js';
import { getReservations, cancelReservation, getResyProfile } from '../bookings/index.js';
import type { BookingsCredentials } from '../auth/types.js';
import { clearCredentials, clearSignedOut as clearSignedOutFlag, isResySharedTokenMode } from '../auth/index.js';
import { extractBookingIntent } from '../booking/nlu.js';
import { handleBookingTurn } from '../booking/pipeline.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are Remi, a premier private concierge accessible by text. You are sophisticated, proactive, and focused on the guest experience. Speak with the quiet confidence of an exceptional maître d'. Never describe yourself as software, an AI, or a bot. Never say you are processing requests, hitting errors, or asking guests to click links generically.

You work with our reservation partner (Resy) to search, hold availability, book, and manage reservations. Messages are delivered via Blooio (docs.blooio.com), which bridges iMessage and SMS.

## Partner verification (Ghost Onboarding) — CRITICAL
Before you ever see a guest message, our system may verify their mobile number with the reservation partner via SMS code. You do not send that code yourself.

NEVER ask a guest to "sign up", "create an account", or "register" with Resy. NEVER lead with "go to resy.com to sign up."

If they ask how access or linking works, answer in hospitality language: we verify this number with our reservation partner; they may receive a short code by text and simply reply here. Keep it effortless.

You never fabricate sign-in or sign-out. If they want to disconnect their reservation partner link, you MUST call the resy_sign_out tool. After sign-out, invite them to message you again when they are ready to verify once more — do not give engineering instructions.

## Payment — CRITICAL
NEVER ask for a credit card number, CVV, or full card details in the chat thread.

When a booking cannot complete because no card is on file with the partner, the tool result will indicate that. Give them the exact Payment setup link from your system context first (verbatim URL — do not invent or shorten it; it is the stable partner login gateway, not a deep link). If a card is required, provide the login link and instruct the guest: "Once you've signed in at the front desk, please tap your profile icon to add a payment method—I'll be standing by to confirm the second it's added." Stay warm and assured, not like a generic error.

Vocabulary: prefer "I've found the table and I'm ready to lock it in" over "error" or "failed".

## What you do
- Search restaurants, check availability by date and party size, book and cancel real reservations
- List upcoming reservations and fetch profile details via resy_profile when helpful
- Give thoughtful recommendations (cuisine, neighborhood, occasion)
- Use web search when guests want nuance beyond availability (reviews, hours, vibe)
## Booking flow — you do NOT drive this
Reservation search, availability checks, proposals, and bookings are handled by a dedicated booking engine — not by you. When a guest asks to book, searches for a restaurant, or confirms a pending proposal, the system intercepts the turn and responds directly. You will not see tool calls for search/slots/book.

If a booking-related request slips through to you (no intercept), it means the guest's message was too ambiguous — ask one clarifying question (restaurant, date, or party size — whichever is missing) in a short, warm line. Do not fabricate venue IDs, times, or confirmations.

Never claim a reservation is booked, held, or set unless the booking engine has said so in the thread. Never write "it's handled", "your table is set", or similar confirmation language unless the guest's prior message shows the booking engine already confirmed.

resy_cancel, resy_reservations, and resy_profile remain yours for existing-reservation management and profile lookup.

If nothing is available, say it gracefully — e.g. that evening is fully committed — without blaming a system.

## Conversation memory
Use full thread context. Resolve "that one", "tomorrow instead", "8pm", ordinals, and follow-ups from prior searches and holds. Remember what was booked or cancelled.

## Style — texting, multi-bubble
You are texting, but in refined concierge sentence case (natural punctuation and apostrophes are fine).

CRITICAL: Use "---" between segments so each part is sent as its own message. Each segment is 1–2 short sentences. Longer replies MUST use --- (not optional).

- NO markdown: no bullets, numbered lists, headers, or bold in messages
- Only ask a question when you truly cannot proceed without the answer
- Do NOT send a progress line before searching — just search and respond with results
- When presenting restaurant options, keep it conversational. No "Here are the top three:" or "I found these spots:" preambles. Just go straight into the options like a friend texting: "A few spots I'd recommend:" or jump right into the names
- When listing options: at most 3. Put EACH option in its own --- segment so they send as separate bubbles. Use the restaurant name and a brief vibe or what it's known for — NOT ratings, numbers, or scores. Sound like a friend who knows the scene, not a search engine.
  Good: "Sushi Izuki — intimate omakase, great for a date night---Aoko — elevated Japanese, killer atmosphere---Sushi Bar Miami Beach — sleek beachside spot"
  Bad: all three crammed into one message
- Never use "@" symbols in restaurant names unless that is the actual name displayed to guests
- Never include numeric ratings (4.98, 4.5/5, etc.) — a concierge describes, they don't rank

## After a successful booking (signature move)
Lead with assurance — e.g. "It's handled." Then the essentials (restaurant, time, party). Then the venue link in a separate bubble. Close with a single gracious line — e.g. whether you can perfect anything else for their evening.

## Commands
- /clear — reset conversation history
- /forget me — erase everything the agent knows about you
- /help — show available commands
- /bookings — show upcoming reservations

## Web search
Use proactively when guests ask about restaurants — reviews, menus, hours, dress code, etc.

## Reactions
Use sparingly; text first. Standard: love, like, dislike, laugh, emphasize, question. Or custom emoji. Never write "[reacted with ...]" in text. On SMS, reactions may not apply — use text only.

## Message Effects
Only when the guest asks or for a truly special moment. Effects: confetti, fireworks, lasers, balloons, sparkles, celebration. Bubble: slam, loud, gentle, invisible_ink. Default: text only. On SMS/RCS, skip effects if the channel does not support them (your platform context will say).`;

function getPaymentSetupUrl(): string {
  const fromEnv = process.env.PAYMENT_SETUP_URL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'https://resy.com/login';
}

function buildSystemPrompt(chatContext?: ChatContext): string {
  let prompt = SYSTEM_PROMPT;

  // Inject current date + upcoming calendar so Claude doesn't have to do date math
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const upcomingDays: string[] = [];
  for (let i = 0; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const label = i === 0 ? 'TODAY' : i === 1 ? 'TOMORROW' : '';
    const line = `${d.toLocaleDateString('en-US', { weekday: 'long' })} ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}${label ? ` (${label})` : ''}`;
    upcomingDays.push(line);
  }
  prompt += `\n\n## Current date\nToday is ${todayStr}.\n\nUpcoming dates (use this reference — do NOT compute dates yourself):\n${upcomingDays.join('\n')}\n\nWhen the guest says "Monday", "this Sunday", "next Friday", etc., look up the EXACT date from the list above. For dates beyond 2 weeks, compute from today's date. Do not guess.`;

  prompt += `\n\n## Payment setup link (stable login gateway — use verbatim when a card is required; avoid deep links)\n${getPaymentSetupUrl()}`;

  if (chatContext?.isHouseAccount) {
    prompt += `\n\n## House Account Mode
This guest has NOT linked their own Resy account. You are booking on their behalf using the house account. This means:
- You CAN search restaurants, check availability, and make bookings — do it seamlessly.
- Reservations, profile, and cancellations will reflect the house account, not the guest's personal Resy.
- Do NOT mention "house account" or "shared account" to the guest. Just book naturally.
- After a successful booking, gently suggest they can link their own Resy account for personal management: "if you ever want to manage reservations directly, just text 'link my resy' and I'll set that up."
- If the guest explicitly asks to link their Resy account (e.g. "link my resy", "connect my account"), tell them you'll get that set up and that they'll receive a verification code shortly. The system will handle the OTP flow.

**Context override:** The "Partner verification (Ghost Onboarding)" section above describes SMS verification before some guests message you — **it does not apply to this thread** unless they choose to link their own account. This guest may book with you without prior partner verification. Do not imply they already completed a verification code unless they actually went through linking.`;
  } else if (isResySharedTokenMode() && !chatContext?.isHouseAccount) {
    prompt += `\n\n## Linked Account
This guest has their own Resy account linked. Full access to their reservations, profile, and bookings.`;
  }

  // Add user profile info if available
  if (chatContext?.senderHandle) {
    const profile = chatContext.senderProfile;
    if (profile?.name || (profile?.facts && profile.facts.length > 0)) {
      prompt += `\n\n## About the person you're talking to (YOU ALREADY KNOW THIS - don't re-save it!)`;
      prompt += `\nHandle: ${chatContext.senderHandle}`;
      if (profile.name) {
        prompt += `\nName: ${profile.name} (already saved - do NOT call remember_user for this)`;
      }
      if (profile.facts && profile.facts.length > 0) {
        prompt += `\nThings you remember about them (already saved):\n- ${profile.facts.join('\n- ')}`;
      }
      prompt += `\n\nUse their name naturally in conversation! Only use remember_user for genuinely NEW info.`;
    } else {
      prompt += `\n\n## About the person you're talking to
Handle: ${chatContext.senderHandle}
You don't know their name yet. If they share it or it comes up naturally, use the remember_user tool to save it!`;
    }
  }

  if (chatContext?.isGroupChat) {
    const participants = chatContext.participantNames.join(', ');
    const chatName = chatContext.chatName ? `"${chatContext.chatName}"` : 'an unnamed group';
    prompt += `\n\n## Group Chat Context
You're in a group chat called ${chatName} with these participants: ${participants}

In group chats:
- Address people by name when responding to them specifically
- Be aware others can see your responses
- Keep responses even shorter since group chats move fast
- Don't react as often in groups - it can feel spammy`;
  }

  if (chatContext?.incomingEffect) {
    prompt += `\n\n## Incoming Message Effect
The user sent their message with a ${chatContext.incomingEffect.type} effect: "${chatContext.incomingEffect.name}". You can acknowledge this if relevant.`;
  }

  if (chatContext?.service) {
    prompt += `\n\n## Messaging Platform
This conversation is happening over ${chatContext.service}.`;
    if (chatContext.service === 'iMessage') {
      prompt += ` All features are available (reactions, effects, typing indicators, read receipts).`;
    } else if (chatContext.service === 'RCS') {
      prompt += ` Reactions and typing indicators work, but screen/bubble effects are not available on RCS.`;
    } else if (chatContext.service === 'SMS') {
      prompt += ` This is basic SMS - no reactions, effects, or typing indicators. Keep responses simple and concise.`;
    }
  }

  if (chatContext?.justOnboarded) {
    const guestName = chatContext.senderProfile?.name?.trim();
    const nameLead = guestName
      ? `Address them as ${guestName} (e.g. "Perfect, ${guestName}.")`
      : 'Welcome them warmly by name only if you already know it from the thread; do not invent a name.';
    prompt += `\n\n## FIRST MESSAGE AFTER PARTNER VERIFICATION
This guest just finished verifying access with our reservation partner. This is their first message to you after that.
${nameLead}
Your very first response MUST:
1) Acknowledge that their access is verified in one short line.
2) Read the conversation history for what they asked before verification (restaurant, time, party, date) and ask in one concise question whether to proceed with that exact request — e.g. shall you proceed with that table at [Restaurant] / that time — using only details that actually appear in history. If the prior ask was vague, offer to clarify one detail instead.
3) Use "---" between the acknowledgment and the follow-up question if both are needed.
Do not re-send verification instructions or mention signing up. Sound like Remi, not IT support.`;
  }

  if (chatContext?.hasPaymentMethod !== undefined) {
    prompt += `\n\n## Partner payment status (silent check — you did not ask for this; our system checked)
The guest ${chatContext.hasPaymentMethod ? 'currently has' : 'does not currently have'} a payment method on file with the reservation partner.`;
    if (chatContext.paymentBecameAvailable) {
      prompt += `\nThey likely just finished at the front-desk verification link. If the conversation already contains a concrete booking request (venue, date, time, party size), continue and complete it with tools without waiting for them to say "I'm done" or "I'm back" — acknowledge briefly in one short line, then proceed.`;
    }
  }

  return prompt;
}

const REACTION_TOOL: Anthropic.Tool = {
  name: 'send_reaction',
  description: 'Send an iMessage reaction to the user\'s message. Use standard tapbacks (love, like, laugh, etc.) OR any custom emoji.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'custom'],
        description: 'The reaction type. Use "custom" to send any emoji.',
      },
      emoji: {
        type: 'string',
        description: 'Required when type is "custom". The emoji to react with.',
      },
    },
    required: ['type'],
  },
};

const EFFECT_TOOL: Anthropic.Tool = {
  name: 'send_effect',
  description: 'Add an iMessage effect to your text response. ONLY use when the user explicitly asks for an effect. You MUST also write a text message.',
  input_schema: {
    type: 'object' as const,
    properties: {
      effect_type: {
        type: 'string',
        enum: ['screen', 'bubble'],
        description: 'Whether this is a full-screen effect or a bubble effect',
      },
      effect: {
        type: 'string',
        enum: ['confetti', 'fireworks', 'lasers', 'sparkles', 'celebration', 'hearts', 'love', 'balloons', 'happy_birthday', 'echo', 'spotlight', 'slam', 'loud', 'gentle', 'invisible_ink'],
        description: 'The specific effect to use',
      },
    },
    required: ['effect_type', 'effect'],
  },
};

const RENAME_CHAT_TOOL: Anthropic.Tool = {
  name: 'rename_group_chat',
  description: 'Rename the current group chat. ONLY use when someone EXPLICITLY asks to rename/name the chat.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: 'The new name for the group chat',
      },
    },
    required: ['name'],
  },
};

const REMEMBER_USER_TOOL: Anthropic.Tool = {
  name: 'remember_user',
  description: 'Save NEW information about someone. ONLY use when you learn genuinely NEW info. NEVER re-save info already shown in the system prompt. CRITICAL: You MUST write a text response too.',
  input_schema: {
    type: 'object' as const,
    properties: {
      handle: {
        type: 'string',
        description: 'The phone number/handle of the person this info is about.',
      },
      name: {
        type: 'string',
        description: 'The person\'s name if they shared it.',
      },
      fact: {
        type: 'string',
        description: 'An interesting fact about them worth remembering.',
      },
    },
  },
};

// Web search uses a special tool type
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
} as unknown as Anthropic.Tool;

// ─── Resy Tools ─────────────────────────────────────────────────────────────
// Search / find_slots / book are intentionally NOT exposed to Claude — the
// deterministic booking pipeline (src/booking/) owns those.

const RESY_CANCEL_TOOL: Anthropic.Tool = {
  name: 'resy_cancel',
  description: 'Cancel a Resy reservation using the resy_token (rr://... format). Get this from resy_reservations results.',
  input_schema: {
    type: 'object' as const,
    properties: {
      resy_token: {
        type: 'string',
        description: 'The resy_token for the reservation to cancel (rr://... format).',
      },
    },
    required: ['resy_token'],
  },
};

const RESY_RESERVATIONS_TOOL: Anthropic.Tool = {
  name: 'resy_reservations',
  description: 'View the user\'s upcoming Resy reservations. Use when someone asks about their bookings, reservations, or upcoming dinner plans.',
  input_schema: {
    type: 'object' as const,
    properties: {},
  },
};

const RESY_PROFILE_TOOL: Anthropic.Tool = {
  name: 'resy_profile',
  description: 'Get the user\'s Resy profile info — name, email, phone, booking count, etc. Use when they ask about their account, "what\'s my name", or you need their details.',
  input_schema: {
    type: 'object' as const,
    properties: {},
  },
};

const RESY_SIGN_OUT_TOOL: Anthropic.Tool = {
  name: 'resy_sign_out',
  description: 'Disconnect the guest\'s reservation partner link. Use when they want to sign out, disconnect, or reset that connection. After calling, invite them to message you when they wish to verify again — keep the tone gracious, not technical.',
  input_schema: {
    type: 'object' as const,
    properties: {},
  },
};

// Tools that return data Claude needs to reason about (require tool-use loop)
const DATA_RETRIEVAL_TOOLS = new Set([
  'resy_reservations',
  'resy_cancel', 'resy_sign_out', 'resy_profile',
]);

const MAX_TOOL_LOOPS = 5;

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';
export type MessageEffect = { type: 'screen' | 'bubble'; name: string };

export type Reaction = {
  type: StandardReactionType;
} | {
  type: 'custom';
  emoji: string;
};

export interface ChatResponse {
  text: string | null;
  reaction: Reaction | null;
  effect: MessageEffect | null;
  renameChat: string | null;
  rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null;
}

export interface ImageInput {
  url: string;
  mimeType: string;
}

export interface AudioInput {
  url: string;
  mimeType: string;
}

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface ChatContext {
  isGroupChat: boolean;
  participantNames: string[];
  chatName: string | null;
  incomingEffect?: { type: 'screen' | 'bubble'; name: string };
  senderHandle?: string;
  senderProfile?: UserProfile | null;
  service?: MessageService;
  bookingsCredentials?: BookingsCredentials | null;
  justOnboarded?: boolean;
  /** Set when this turn ran a silent Resy /2/user payment check (booking-related messages). */
  hasPaymentMethod?: boolean;
  /** True when the guest went from no saved partner card to having one since the last snapshot. */
  paymentBecameAvailable?: boolean;
  /** True when using the house/shared Resy account instead of the user's own linked account. */
  isHouseAccount?: boolean;
}

/**
 * Convert stored messages to Anthropic format, adding sender attribution for group chats.
 */
function formatHistoryForClaude(messages: StoredMessage[], isGroupChat: boolean): Anthropic.MessageParam[] {
  return messages.map(msg => {
    let content = msg.content;
    if (isGroupChat && msg.role === 'user' && msg.handle) {
      content = `[${msg.handle}]: ${content}`;
    }
    return { role: msg.role, content };
  });
}

/** Detect confident fake-booking claims in Claude's text (booking engine is the source of truth). */
function textImpliesConfirmedBooking(text: string | null): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (t.includes('[booked a reservation]')) return true;
  if (t.includes("it's handled") || t.includes('it\u2019s handled')) return true;
  if (/\byou'?re (all )?set\b/.test(t) && /\b(table|reservation)\b/.test(t)) return true;
  if (/\ball set\b/.test(t) && /\b(table|reservation|booked)\b/.test(t)) return true;
  return false;
}

export async function chat(chatId: string, userMessage: string, images: ImageInput[] = [], audio: AudioInput[] = [], chatContext?: ChatContext): Promise<ChatResponse> {
  const emptyResponse = {
    reaction: null,
    effect: null,
    renameChat: null,
    rememberedUser: null,
  };

  const cmd = userMessage.toLowerCase().trim();

  // Handle special commands
  if (cmd === '/help') {
    return {
      text: "commands:\n/clear - reset our conversation\n/forget me - erase what i know about you\n/bookings - show your reservations\n/help - this message",
      ...emptyResponse,
    };
  }

  if (cmd === '/clear') {
    await clearConversation(chatId);
    return { text: "conversation cleared, fresh start", ...emptyResponse };
  }

  if (cmd === '/forget me' || cmd === '/forgetme') {
    if (chatContext?.senderHandle) {
      await clearUserProfile(chatContext.senderHandle);
      return { text: "done, ive forgotten everything about you. were strangers now", ...emptyResponse };
    }
    return { text: "hmm couldnt figure out who you are to forget you", ...emptyResponse };
  }

  if (cmd === '/bookings' && chatContext?.isHouseAccount) {
    await addMessage(chatId, 'user', userMessage.trim(), chatContext?.senderHandle);
    return {
      text: "to see your personal reservations here, link your own resy — just text 'link my resy'. until then i can still find tables and book for you whenever you like.",
      ...emptyResponse,
    };
  }

  // Per-user Resy auth token
  const resyAuthToken = chatContext?.bookingsCredentials?.resyAuthToken ?? null;

  // Get conversation history
  const history = await getConversation(chatId);

  // Build message content
  const messageContent: Anthropic.ContentBlockParam[] = [];

  for (const image of images) {
    messageContent.push({
      type: 'image',
      source: { type: 'url', url: image.url },
    });
  }

  let textToSend = userMessage.trim();
  if (!textToSend && images.length > 0) {
    textToSend = "What's in this image?";
  }
  if (textToSend) {
    messageContent.push({ type: 'text', text: textToSend });
  }

  if (textToSend) {
    await addMessage(chatId, 'user', textToSend, chatContext?.senderHandle);
  }

  // ── Deterministic booking pipeline ──────────────────────────────────────
  // Intercepts booking-related turns (search/propose/confirm). Falls through
  // to Claude for chit-chat, profile questions, and anything non-booking.
  if (resyAuthToken && textToSend) {
    try {
      const intent = await extractBookingIntent(textToSend, history);
      const pipelineResult = await handleBookingTurn({
        chatId,
        userMessage: textToSend,
        history,
        intent,
        resyAuthToken,
      });
      if (pipelineResult.handled) {
        if (pipelineResult.text) {
          await addMessage(chatId, 'assistant', pipelineResult.text);
        }
        return {
          text: pipelineResult.text || null,
          reaction: null,
          effect: pipelineResult.booked ? { type: 'screen', name: 'celebration' } : null,
          renameChat: null,
          rememberedUser: null,
        };
      }
    } catch (err) {
      console.error('[claude] booking pipeline error, falling back to Claude:', err instanceof Error ? err.message : err);
    }
  }

  try {
    const formattedHistory = formatHistoryForClaude(history, chatContext?.isGroupChat ?? false);

    // Build tools list. Search/find_slots/book are owned by the booking pipeline.
    const tools: Anthropic.Tool[] = [
      REACTION_TOOL, EFFECT_TOOL, REMEMBER_USER_TOOL, WEB_SEARCH_TOOL,
    ];
    if (resyAuthToken && !chatContext?.isHouseAccount) {
      tools.push(
        RESY_CANCEL_TOOL,
        RESY_RESERVATIONS_TOOL,
        RESY_PROFILE_TOOL,
        RESY_SIGN_OUT_TOOL,
      );
    }
    if (chatContext?.isGroupChat) {
      tools.push(RENAME_CHAT_TOOL);
    }

    // ── Tool-use loop ──────────────────────────────────────────────────────
    const messages: Anthropic.MessageParam[] = [...formattedHistory, { role: 'user', content: messageContent }];
    let response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: buildSystemPrompt(chatContext),
      tools,
      messages,
    });

    let loopCount = 0;
    while (response.stop_reason === 'tool_use' && loopCount < MAX_TOOL_LOOPS) {
      const hasDataTools = response.content.some(
        block => block.type === 'tool_use' && DATA_RETRIEVAL_TOOLS.has(block.name)
      );
      if (!hasDataTools) break;

      console.log(`[claude] Tool-use loop iteration ${loopCount + 1}`);

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        // ── Resy tool execution ───────────────────────────────────
        if (block.name === 'resy_cancel') {
          const input = block.input as { resy_token: string };
          try {
            const result = await cancelReservation(resyAuthToken!, input.resy_token);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_cancel error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error cancelling reservation: ${msg}`, is_error: true });
          }

        } else if (block.name === 'resy_reservations') {
          try {
            const reservations = await getReservations(resyAuthToken!);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(reservations) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_reservations error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error fetching reservations: ${msg}`, is_error: true });
          }

        } else if (block.name === 'resy_profile') {
          try {
            const profile = await getResyProfile(resyAuthToken!);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(profile) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_profile error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error fetching profile: ${msg}`, is_error: true });
          }

        } else if (block.name === 'resy_sign_out') {
          if (chatContext?.senderHandle) {
            await clearCredentials(chatContext.senderHandle);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Signed out successfully. Credentials removed.' });
            console.log(`[claude] User signed out via tool call`);
          } else {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Could not determine user identity.', is_error: true });
          }

        } else {
          // Fire-and-forget tools
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'ok' });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: buildSystemPrompt(chatContext),
        tools,
        messages,
      });

      loopCount++;
    }

    // ── Extract fire-and-forget tools from ALL responses ─────────────────
    let reaction: Reaction | null = null;
    let effect: MessageEffect | null = null;
    let renameChat: string | null = null;
    let rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null = null;

    const allAssistantBlocks = messages
      .filter((m): m is Anthropic.MessageParam & { role: 'assistant' } => m.role === 'assistant')
      .flatMap(m => Array.isArray(m.content) ? m.content : []);
    const allBlocks = [...allAssistantBlocks, ...response.content];

    for (const block of allBlocks) {
      if (block.type === 'tool_use' && block.name === 'send_reaction') {
        const input = block.input as { type: ReactionType; emoji?: string };
        if (input.type === 'custom' && input.emoji) {
          reaction = { type: 'custom', emoji: input.emoji };
        } else if (input.type !== 'custom') {
          reaction = { type: input.type as StandardReactionType };
        }
      } else if (block.type === 'tool_use' && block.name === 'send_effect') {
        const input = block.input as { effect_type: 'screen' | 'bubble'; effect: string };
        effect = { type: input.effect_type, name: input.effect };
      } else if (block.type === 'tool_use' && block.name === 'rename_group_chat') {
        const input = block.input as { name: string };
        renameChat = input.name;
      } else if (block.type === 'tool_use' && block.name === 'remember_user') {
        const input = block.input as { handle?: string; name?: string; fact?: string };
        const targetHandle = input.handle || chatContext?.senderHandle;
        if (targetHandle) {
          let nameChanged = false;
          let factChanged = false;

          if (input.name) {
            nameChanged = await setUserName(targetHandle, input.name);
          }
          if (input.fact) {
            factChanged = await addUserFact(targetHandle, input.fact);
          }

          if (nameChanged || factChanged) {
            const isForSender = !input.handle || input.handle === chatContext?.senderHandle;
            rememberedUser = {
              name: nameChanged ? input.name : undefined,
              fact: factChanged ? input.fact : undefined,
              isForSender
            };
          }
        }
      }
    }

    // Only take text from the FINAL response
    const finalTextParts: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        finalTextParts.push(block.text);
      }
    }
    let textResponse = finalTextParts.length > 0 ? finalTextParts.join('\n') : null;

    // Strip internal tool-summary tags that Claude may parrot from conversation history
    if (textResponse) {
      textResponse = textResponse.replace(/\[(?:checked slots|searched resy|booked a reservation|resy_book|cancelled a reservation|checked upcoming reservations|checked resy profile|signed out of resy)[^\]]*\]\s*/g, '').trim() || null;
    }

    // Belt-and-suspenders: Claude should never claim a booking on this code path
    // (the pipeline owns booking). If it does, replace with a gentle reset.
    if (textImpliesConfirmedBooking(textResponse)) {
      console.warn('[claude] Replaced model text that claimed a booking on the non-pipeline path');
      textResponse =
        "let me pull that up properly — what restaurant, date, and time were you thinking?";
    }

    // Build a summary of tool calls for conversation history
    const toolSummaryParts: string[] = [];
    for (const block of allBlocks) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'resy_cancel') {
        toolSummaryParts.push(`[cancelled a reservation]`);
      } else if (block.name === 'resy_reservations') {
        toolSummaryParts.push(`[checked upcoming reservations]`);
      } else if (block.name === 'resy_profile') {
        toolSummaryParts.push(`[checked resy profile]`);
      } else if (block.name === 'resy_sign_out') {
        toolSummaryParts.push(`[signed out of resy]`);
      }
    }

    // Add assistant response to history (include tool context so Claude remembers what it did)
    if (textResponse) {
      const cleanedText = textResponse.split('---').map(m => m.trim()).filter(m => m).join(' ');
      const historyMessage = toolSummaryParts.length > 0
        ? `${toolSummaryParts.join(' ')} ${cleanedText}`
        : cleanedText;
      await addMessage(chatId, 'assistant', historyMessage);
    } else if (effect) {
      await addMessage(chatId, 'assistant', `[sent ${effect.name} effect]`);
    } else if (reaction) {
      const reactionDisplay = reaction.type === 'custom' ? (reaction as { type: 'custom'; emoji: string }).emoji : reaction.type;
      await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);
    }

    return { text: textResponse, reaction, effect, renameChat, rememberedUser };
  } catch (error) {
    console.error('[claude] API error:', error);
    throw error;
  }
}

/**
 * Simple text-only completion for follow-up requests (no tools).
 */
export async function getTextForEffect(effectName: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Write a very short, fun message (under 10 words) to send with a ${effectName} iMessage effect. Just the message, nothing else.`
    }],
  });

  if (response.content[0].type === 'text') {
    return response.content[0].text;
  }
  return `${effectName}!`;
}

export type GroupChatAction = 'respond' | 'react' | 'ignore';

/**
 * Use Haiku to quickly determine how Claude should handle a group chat message.
 */
export async function getGroupChatAction(
  message: string,
  sender: string,
  chatId: string
): Promise<{ action: GroupChatAction; reaction?: Reaction }> {
  const start = Date.now();
  const history = await getConversation(chatId);
  const recentMessages = history.slice(-4);

  let contextBlock = '';
  if (recentMessages.length > 0) {
    const formatted = recentMessages.map(msg => {
      if (msg.role === 'assistant') return `Assistant: ${msg.content}`;
      const sender = msg.handle || 'Someone';
      return `${sender}: ${msg.content}`;
    }).join('\n');
    contextBlock = `\nRecent conversation:\n${formatted}\n`;
  }

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 20,
      system: `You classify how an AI booking assistant should handle messages in a group chat.

IMPORTANT: BIAS TOWARD "respond" - text responses are almost always better than reactions.

Answer with ONE of these:
- "respond" - The assistant should send a text reply. USE THIS BY DEFAULT when:
  * They asked about restaurants, bookings, reservations, or plans
  * They mentioned the bot or assistant
  * They're continuing a conversation
  * You're unsure - default to respond
- "react:love" or "react:like" or "react:laugh" - ONLY for brief acknowledgments
- "ignore" - Human-to-human conversation not involving the assistant`,
      messages: [{
        role: 'user',
        content: `${contextBlock}New message from ${sender}: "${message}"\n\nHow should the assistant handle this?`
      }],
    });

    const answer = response.content[0].type === 'text'
      ? response.content[0].text.toLowerCase().trim()
      : 'ignore';

    let action: GroupChatAction = 'ignore';
    let reaction: Reaction | undefined;

    if (answer.includes('respond')) {
      action = 'respond';
    } else if (answer.includes('react')) {
      action = 'react';
      if (answer.includes('love')) reaction = { type: 'love' };
      else if (answer.includes('laugh')) reaction = { type: 'laugh' };
      else if (answer.includes('like')) reaction = { type: 'like' };
      else reaction = { type: 'like' };
    }

    console.log(`[claude] groupChatAction (${Date.now() - start}ms): "${message.substring(0, 50)}..." -> ${action}`);
    return { action, reaction };
  } catch (error) {
    console.error('[claude] groupChatAction error:', error);
    return { action: 'ignore' };
  }
}
