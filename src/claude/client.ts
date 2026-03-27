import Anthropic from '@anthropic-ai/sdk';
import { getConversation, addMessage, clearConversation, getUserProfile, setUserName, addUserFact, clearUserProfile, UserProfile, StoredMessage } from '../state/conversation.js';
import { searchRestaurants, findSlots, bookReservation, getReservations, cancelReservation, getResyProfile } from '../bookings/index.js';
import type { BookingsCredentials } from '../auth/types.js';
import { clearCredentials, clearSignedOut as clearSignedOutFlag, isResySharedTokenMode } from '../auth/index.js';

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

## Resy booking flow (tools)
1. resy_search → venue IDs
2. resy_find_slots → open times for date and party size
3. resy_book → only after explicit guest confirmation; this creates a REAL reservation
4. resy_cancel → requires resy_token from resy_reservations

When a booking succeeds, ALWAYS send venue_url from the confirmation as its own message so the guest can tap it. Example tone: "It's handled." --- "Your table at [Restaurant] is set for [time]." --- then the URL on its own line after --- .

If nothing is available, say it gracefully — e.g. that evening is fully committed — without blaming a system.

## Conversation memory
Use full thread context. Resolve "that one", "tomorrow instead", "8pm", ordinals, and follow-ups from prior searches and holds. Remember what was booked or cancelled.

## Style — texting, multi-bubble
You are texting, but in refined concierge sentence case (natural punctuation and apostrophes are fine).

CRITICAL: Use "---" between segments so each part is sent as its own message. Each segment is 1–2 short sentences. Longer replies MUST use --- (not optional).

- NO markdown: no bullets, numbered lists, headers, or bold in messages
- One question per turn when you need information; no interrogation checklists
- Before resy_search or resy_find_slots, send one brief progress line first (e.g. "I'm looking into that now.")
- When listing options: at most 3; each one line: "<name> — <short descriptor>, <time or note>"
- No filler ratings dumps or long paragraphs when listing spots

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
  prompt += `\n\n## Payment setup link (stable login gateway — use verbatim when a card is required; avoid deep links)\n${getPaymentSetupUrl()}`;

  if (isResySharedTokenMode()) {
    prompt += `\n\n## Concierge Dev Mode
You are currently operating in Concierge Dev Mode. You have the power to book immediately. If a card is missing from the master account, use the Stable Login link: https://resy.com/login.`;
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

const RESY_SEARCH_TOOL: Anthropic.Tool = {
  name: 'resy_search',
  description: 'Search for restaurants on Resy. Use when someone asks about finding a place to eat or a restaurant. Returns venue IDs needed for checking availability.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search keyword (e.g., "italian", "sushi", "steakhouse", "Carbone").',
      },
      lat: {
        type: 'number',
        description: 'Latitude for location-based search. Defaults to NYC.',
      },
      lng: {
        type: 'number',
        description: 'Longitude for location-based search. Defaults to NYC.',
      },
    },
    required: ['query'],
  },
};

const RESY_FIND_SLOTS_TOOL: Anthropic.Tool = {
  name: 'resy_find_slots',
  description: 'Find available time slots at a Resy venue for a given date and party size. Returns config tokens needed for booking.',
  input_schema: {
    type: 'object' as const,
    properties: {
      venue_id: {
        type: 'number',
        description: 'The Resy venue ID (from resy_search results).',
      },
      date: {
        type: 'string',
        description: 'Date to check (YYYY-MM-DD format).',
      },
      party_size: {
        type: 'number',
        description: 'Number of guests.',
      },
      lat: {
        type: 'number',
        description: 'Latitude. Defaults to NYC.',
      },
      lng: {
        type: 'number',
        description: 'Longitude. Defaults to NYC.',
      },
    },
    required: ['venue_id', 'date', 'party_size'],
  },
};

const RESY_BOOK_TOOL: Anthropic.Tool = {
  name: 'resy_book',
  description: 'Book a reservation on Resy. Automatically finds a fresh slot at booking time so tokens dont expire. This makes a REAL reservation — always confirm venue, date, time, and party size with the user before calling this.',
  input_schema: {
    type: 'object' as const,
    properties: {
      venue_id: {
        type: 'number',
        description: 'The Resy venue ID (from resy_search results).',
      },
      date: {
        type: 'string',
        description: 'Reservation date (YYYY-MM-DD).',
      },
      party_size: {
        type: 'number',
        description: 'Number of guests.',
      },
      time: {
        type: 'string',
        description: 'Desired time in HH:MM 24h format (e.g., "19:00"). Picks the closest available slot.',
      },
    },
    required: ['venue_id', 'date', 'party_size'],
  },
};

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
  'resy_search', 'resy_find_slots', 'resy_reservations',
  'resy_book', 'resy_cancel', 'resy_sign_out', 'resy_profile',
]);

const MAX_TOOL_LOOPS = 5;
const MAX_CACHED_VENUES = 20;

type VenueSelection = { venue_id: number; name: string };
const recentVenueOptionsByChat = new Map<string, VenueSelection[]>();

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function ordinalToIndex(message: string): number | null {
  const m = normalizeText(message);
  const byWord: Record<string, number> = {
    first: 0,
    second: 1,
    third: 2,
    fourth: 3,
    fifth: 4,
  };
  for (const [word, idx] of Object.entries(byWord)) {
    if (m.includes(word)) return idx;
  }
  const numMatch = m.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
  if (!numMatch) return null;
  const n = Number(numMatch[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n - 1;
}

function resolveVenueFromSelection(
  chatId: string,
  userMessage: string,
  fallbackVenueId: number,
): number {
  const cached = recentVenueOptionsByChat.get(chatId);
  if (!cached || cached.length === 0) return fallbackVenueId;

  const normalizedMessage = normalizeText(userMessage);
  if (!normalizedMessage) return fallbackVenueId;

  // Strongest signal: explicit restaurant name mention.
  for (const venue of cached) {
    const normalizedName = normalizeText(venue.name);
    if (normalizedName.length >= 3 && normalizedMessage.includes(normalizedName)) {
      return venue.venue_id;
    }
  }

  // Secondary signal: "first/second/3rd one"
  const idx = ordinalToIndex(normalizedMessage);
  if (idx !== null && idx >= 0 && idx < cached.length) {
    return cached[idx].venue_id;
  }

  return fallbackVenueId;
}

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

  try {
    const formattedHistory = formatHistoryForClaude(history, chatContext?.isGroupChat ?? false);

    // Build tools list
    const tools: Anthropic.Tool[] = [
      REACTION_TOOL, EFFECT_TOOL, REMEMBER_USER_TOOL, WEB_SEARCH_TOOL,
    ];
    if (resyAuthToken) {
      tools.push(
        RESY_SEARCH_TOOL, RESY_FIND_SLOTS_TOOL,
        RESY_BOOK_TOOL, RESY_CANCEL_TOOL,
        RESY_RESERVATIONS_TOOL,
        RESY_PROFILE_TOOL,
        RESY_SIGN_OUT_TOOL,
      );
    }
    if (chatContext?.isGroupChat) {
      tools.push(RENAME_CHAT_TOOL);
    }

    // ── Tool-use loop ──────────────────────────────────────────────────────
    let bookingSucceeded = false; // Track if a resy_book call succeeded
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
        if (block.name === 'resy_search') {
          const input = block.input as { query: string; lat?: number; lng?: number };
          try {
            const geo = input.lat && input.lng ? { lat: input.lat, lng: input.lng } : undefined;
            const results = await searchRestaurants(resyAuthToken!, input.query, geo);
            recentVenueOptionsByChat.set(
              chatId,
              results.slice(0, MAX_CACHED_VENUES).map(r => ({ venue_id: r.venue_id, name: r.name })),
            );
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(results) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_search error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error searching restaurants: ${msg}`, is_error: true });
          }

        } else if (block.name === 'resy_find_slots') {
          const input = block.input as { venue_id: number; date: string; party_size: number; lat?: number; lng?: number };
          try {
            const resolvedVenueId = resolveVenueFromSelection(chatId, userMessage, input.venue_id);
            if (resolvedVenueId !== input.venue_id) {
              console.log(`[claude] Resolved venue for slots: ${input.venue_id} -> ${resolvedVenueId} from user selection`);
            }
            const geo = input.lat && input.lng ? { lat: input.lat, lng: input.lng } : undefined;
            const slots = await findSlots(resyAuthToken!, resolvedVenueId, input.date, input.party_size, geo);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(slots) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_find_slots error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error finding slots: ${msg}`, is_error: true });
          }

        } else if (block.name === 'resy_book') {
          const input = block.input as { venue_id: number; date: string; party_size: number; time?: string };
          try {
            const resolvedVenueId = resolveVenueFromSelection(chatId, userMessage, input.venue_id);
            if (resolvedVenueId !== input.venue_id) {
              console.log(`[claude] Resolved venue for booking: ${input.venue_id} -> ${resolvedVenueId} from user selection`);
            }
            const confirmation = await bookReservation(resyAuthToken!, resolvedVenueId, input.date, input.party_size, input.time);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(confirmation) });
            bookingSucceeded = true;
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_book error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error booking reservation: ${msg}`, is_error: true });
          }

        } else if (block.name === 'resy_cancel') {
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

    // Auto-celebration: if a booking was successfully made, send confetti
    if (bookingSucceeded && !effect) {
      effect = { type: 'screen', name: 'celebration' };
      console.log('[claude] Auto-attaching celebration effect for successful booking');
    }

    // Only take text from the FINAL response
    const finalTextParts: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        finalTextParts.push(block.text);
      }
    }
    const textResponse = finalTextParts.length > 0 ? finalTextParts.join('\n') : null;

    // Build a summary of tool calls for conversation history
    // This lets Claude reference prior searches, bookings, etc. in follow-up messages
    const toolSummaryParts: string[] = [];
    for (const block of allBlocks) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'resy_search') {
        const input = block.input as { query: string };
        toolSummaryParts.push(`[searched resy for "${input.query}"]`);
      } else if (block.name === 'resy_find_slots') {
        const input = block.input as { venue_id: number; date: string; party_size: number };
        toolSummaryParts.push(`[checked slots: venue ${input.venue_id}, ${input.date}, party of ${input.party_size}]`);
      } else if (block.name === 'resy_book') {
        toolSummaryParts.push(`[booked a reservation]`);
      } else if (block.name === 'resy_cancel') {
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
