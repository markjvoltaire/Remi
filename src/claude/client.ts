import Anthropic from '@anthropic-ai/sdk';
import { getConversation, addMessage, clearConversation, getUserProfile, setUserName, addUserFact, clearUserProfile, UserProfile, StoredMessage } from '../state/conversation.js';
import { searchRestaurants, findSlots, bookReservation, getReservations, cancelReservation, getResyProfile } from '../bookings/index.js';
import type { ResyBookingConfirmation } from '../bookings/types.js';
import type { BookingsCredentials } from '../auth/types.js';
import { clearCredentials, clearSignedOut as clearSignedOutFlag, isResySharedTokenMode } from '../auth/index.js';
import { buildUberRideDeepLink } from '../concierge/uberRideLink.js';
import { inferResyGeoFromText, threadSnippetForGeo } from '../bookings/geo.js';
import {
  createDelivery,
  DoorDashApiError,
  isDoorDashConfigured,
  type DoorDashCreateDeliveryRequest,
} from '../doordash/index.js';

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
- When they want a ride, car, or Uber, or transport: you cannot hail a car yourself — you build a tap link. **Do not call uber_ride_link until you have both pickup and destination** (see Rides flow below). If they already stated both clearly in the thread, skip straight to the tool.
- When they want **food or package delivery** via DoorDash Drive: you cannot wing it — see **DoorDash delivery** below. Never invent addresses, phone numbers, or dollar amounts.

## Resy booking flow (tools)
1. resy_search → venue IDs
2. resy_find_slots → open times for date and party size
3. resy_book → only after explicit guest confirmation; this creates a REAL reservation
4. resy_cancel → requires resy_token from resy_reservations

When the guest names a city (e.g. Miami, Los Angeles), the search geo should match that market — pass lat/lng in tools or ensure the thread mentions the city so results are not NYC-biased. Use venue_id values exactly from resy_search results; do not invent IDs.

BOOKING INTEGRITY (non-negotiable): You must call resy_book and receive a successful tool result before you tell the guest anything is booked, confirmed, or secured — including phrases like "it's handled" or "your table is set." If you have not completed resy_book successfully in this turn, do not imply the reservation exists; say you are still locking it in or ask what you need next. Never write "[booked a reservation]" in guest-facing text (internal logging only).

When resy_book returns a confirmation JSON, ALWAYS send venue_url from that result as its own message segment so the guest can tap it. Example structure: short assurance --- essentials (name, date, time, party) --- venue_url on its own line (use --- between segments).

## Rides — two questions, then the link
When they ask for a ride (first time or missing info), **one question per message only**:
1) If you do not know **where they are** (pickup), ask only that — e.g. where should pickup be, or if they're fine using their current location in the app.
2) After they answer, if you do not know **where they're going**, ask only that.
3) When you have both, call uber_ride_link (use pickup_my_location / omit pickup address if they chose current location). Send the URL on its own line in a separate --- segment. Warm short line before the link.

When uber_ride_link returns a URL, include uber_url verbatim on its own line so it stays tappable, same as venue links.

If nothing is available, say it gracefully — e.g. that evening is fully committed — without blaming a system.

## DoorDash delivery — staged, not a form
When a guest wants something **picked up and brought to them** (DoorDash Drive), the tool needs structured fields, but your **conversation must stay concierge-like**: short lines, **one missing detail per message** when possible, no numbered checklists or "required fields" language. Say you're locking it in or sending the Dasher — never "submit the form."

**Do not call doordash_create_delivery** until **all** of the following are explicitly stated in the thread (never guess):
- Full pickup address + pickup business name (e.g. which McDonald's)
- Full dropoff address + dropoff business name (e.g. "Mark — home" with a real address)
- Pickup and dropoff **E.164** phone numbers — if the guest confirms **one number for both**, use that same value for both fields in the tool
- **order_value** as integer **cents** (ask "roughly how much before tip?" in plain language, then convert)

**Suggested order** (skip steps they already answered): acknowledge intent → which store/address to pick up → where to bring it → best phone(s) for the driver → rough order total → then the tool → brief confirmation (include external id or status from the tool result if helpful).

While using **sandbox** credentials, deliveries are simulated — you may mention that lightly if they ask, without sounding technical.

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
        description: 'Latitude for location-based search. OMIT only if the guest did not name a city — the system infers Miami, LA, etc. from the thread; otherwise set explicitly when you know the market.',
      },
      lng: {
        type: 'number',
        description: 'Longitude for location-based search. Pair with lat (same rules).',
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
        description: 'Latitude for /4/find (should match the city of the venue). Omit if the thread already names the city — the system infers common markets.',
      },
      lng: {
        type: 'number',
        description: 'Longitude for /4/find; pair with lat.',
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

const UBER_RIDE_LINK_TOOL: Anthropic.Tool = {
  name: 'uber_ride_link',
  description:
    'Build a tap-friendly Uber deep link. Call ONLY after the guest has provided both pickup and destination in the conversation (pickup may be "current location" / use my location). If they just said they want a ride and either is missing, do NOT call this — ask pickup first in one message, then destination in the next. Use addresses or place names from the thread; add city or neighborhood if needed for clarity.',
  input_schema: {
    type: 'object' as const,
    properties: {
      dropoff_formatted_address: {
        type: 'string',
        description: 'Destination as a full address or descriptive place string (e.g. "Carbone, New York, NY").',
      },
      dropoff_nickname: {
        type: 'string',
        description: 'Short label for the destination (e.g. venue name) — optional, pairs well with address.',
      },
      pickup_formatted_address: {
        type: 'string',
        description: 'Pickup address if they specified one; leave empty to use their current location in the Uber app.',
      },
      pickup_my_location: {
        type: 'boolean',
        description: 'If true (default), pickup is their current GPS location. Set false only when pickup_formatted_address is set.',
      },
    },
  },
};

const DOORDASH_CREATE_DELIVERY_TOOL: Anthropic.Tool = {
  name: 'doordash_create_delivery',
  description:
    'Create a DoorDash Drive delivery (sandbox or production per environment). Do NOT call until pickup_address, pickup_business_name, pickup_phone_number, dropoff_address, dropoff_business_name, dropoff_phone_number, and order_value (integer cents) are all explicitly confirmed in the thread — collect over multiple turns, one question at a time when possible, like the Rides flow. Never invent addresses or phones; if the guest says one number works for pickup and dropoff, pass the same E.164 string for both phone fields.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pickup_address: { type: 'string', description: 'Full street address for pickup.' },
      pickup_business_name: { type: 'string', description: 'Business name at pickup (e.g. restaurant name).' },
      pickup_phone_number: { type: 'string', description: 'E.164 phone for pickup contact.' },
      pickup_instructions: { type: 'string', description: 'Optional pickup notes for the Dasher.' },
      dropoff_address: { type: 'string', description: 'Full street address for dropoff.' },
      dropoff_business_name: { type: 'string', description: 'Recipient or place label at dropoff.' },
      dropoff_phone_number: { type: 'string', description: 'E.164 phone for dropoff contact.' },
      dropoff_instructions: { type: 'string', description: 'Optional dropoff notes.' },
      order_value: {
        type: 'number',
        description: 'Declared order value in integer cents (e.g. 1999 for $19.99), from what the guest confirmed.',
      },
    },
    required: [
      'pickup_address',
      'pickup_business_name',
      'pickup_phone_number',
      'dropoff_address',
      'dropoff_business_name',
      'dropoff_phone_number',
      'order_value',
    ],
  },
};

// Tools that return data Claude needs to reason about (require tool-use loop)
const DATA_RETRIEVAL_TOOLS = new Set([
  'resy_search', 'resy_find_slots', 'resy_reservations',
  'resy_book', 'resy_cancel', 'resy_sign_out', 'resy_profile',
  'uber_ride_link',
  'doordash_create_delivery',
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

/**
 * Pick a venue from the last resy_search cache using the full thread (not just the latest SMS),
 * with Miami vs NYC (etc.) disambiguation when multiple venues share a short name like "Carbone".
 */
function resolveVenueFromSelection(
  chatId: string,
  threadText: string,
  fallbackVenueId: number,
): number {
  const cached = recentVenueOptionsByChat.get(chatId);
  if (!cached || cached.length === 0) return fallbackVenueId;

  const normalizedMessage = normalizeText(threadText);
  if (!normalizedMessage) return fallbackVenueId;

  const candidates: VenueSelection[] = [];
  for (const venue of cached) {
    const normalizedName = normalizeText(venue.name);
    if (normalizedName.length >= 3 && normalizedMessage.includes(normalizedName)) {
      candidates.push(venue);
    }
  }

  let pool = candidates;
  if (pool.length === 0) {
    const idx = ordinalToIndex(normalizedMessage);
    if (idx !== null && idx >= 0 && idx < cached.length) {
      return cached[idx].venue_id;
    }
    return fallbackVenueId;
  }

  const miamiHint = /\b(miami|south beach|brickell|wynwood|collins|coral gables|miami beach|florida)\b/i.test(threadText);
  const nyHint = /\b(new york|nyc|manhattan|brooklyn|queens|soho|tribeca|west village|ues)\b/i.test(threadText);
  if (miamiHint) {
    const narrowed = pool.filter(v => /\bmiami|beach|south|collins|florida\b/i.test(v.name));
    if (narrowed.length > 0) pool = narrowed;
  } else if (nyHint) {
    const narrowed = pool.filter(v => !/\bmiami\b/i.test(v.name));
    if (narrowed.length > 0) pool = narrowed;
  }

  pool = [...pool].sort(
    (a, b) => normalizeText(b.name).length - normalizeText(a.name).length,
  );
  return pool[0].venue_id;
}

/**
 * If we have search results for this chat, refuse to call Resy with an arbitrary venue_id (hallucinated or stale).
 * Falls back to name-based disambiguation within the cached list only.
 */
function coerceVenueToCachedOnly(chatId: string, threadText: string, venueId: number): number | null {
  const cached = recentVenueOptionsByChat.get(chatId);
  if (!cached?.length) return venueId;

  const allowed = new Set(cached.map(v => v.venue_id));
  if (allowed.has(venueId)) return venueId;

  const resolved = resolveVenueFromSelection(chatId, threadText, venueId);
  if (allowed.has(resolved)) return resolved;

  console.warn(
    `[claude] Venue ${venueId} is not in the current Resy search cache (have: ${[...allowed].join(', ')}); need a fresh resy_search for the right city.`,
  );
  return null;
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

const PENDING_SLOT_CHECK_RE = /\[checked slots: venue (\d+), (\d{4}-\d{2}-\d{2}), party of (\d+)\]/;

function parsePendingSlotCheckFromHistory(messages: StoredMessage[]): { venueId: number; date: string; partySize: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const m = msg.content.match(PENDING_SLOT_CHECK_RE);
    if (m) {
      return { venueId: Number(m[1]), date: m[2], partySize: Number(m[3]) };
    }
  }
  return null;
}

/** Parses common guest times (e.g. "6:00 pm", "18:30") to HH:MM 24h for Resy. */
function parseGuestTimeToHHMM(message: string): string | null {
  const t = message.trim().toLowerCase();
  if (!t) return null;

  const mer = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a|p)\.?m\.?\b/);
  if (mer) {
    let h = parseInt(mer[1], 10);
    const mins = mer[2] ? parseInt(mer[2], 10) : 0;
    if (!Number.isFinite(h) || !Number.isFinite(mins)) return null;
    if (mer[3] === 'p' && h < 12) h += 12;
    if (mer[3] === 'a' && h === 12) h = 0;
    return `${h.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
  }

  const twentyFour = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFour) {
    return `${twentyFour[1].padStart(2, '0')}:${twentyFour[2]}`;
  }

  return null;
}

function buildBookingConfirmationText(c: ResyBookingConfirmation): string {
  return `It's handled. --- Your table at ${c.venue_name} is set for ${c.date} at ${c.time}, party of ${c.party_size}. --- ${c.venue_url}`;
}

/** Model sometimes mimics a successful book without calling resy_book — detect confident false claims. */
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

  try {
    const formattedHistory = formatHistoryForClaude(history, chatContext?.isGroupChat ?? false);
    const recentLinesForGeo = history.slice(-20).map(m => m.content);
    const venueThreadText = threadSnippetForGeo(textToSend.trim(), recentLinesForGeo);
    const inferredGeo = inferResyGeoFromText(venueThreadText);

    // Build tools list
    const tools: Anthropic.Tool[] = [
      REACTION_TOOL, EFFECT_TOOL, REMEMBER_USER_TOOL, WEB_SEARCH_TOOL, UBER_RIDE_LINK_TOOL,
    ];
    if (isDoorDashConfigured()) {
      tools.push(DOORDASH_CREATE_DELIVERY_TOOL);
    }
    if (resyAuthToken) {
      // All users get search, slots, and booking tools
      tools.push(RESY_SEARCH_TOOL, RESY_FIND_SLOTS_TOOL, RESY_BOOK_TOOL);

      // Personal account tools only for linked (non-house) users
      if (!chatContext?.isHouseAccount) {
        tools.push(
          RESY_CANCEL_TOOL,
          RESY_RESERVATIONS_TOOL,
          RESY_PROFILE_TOOL,
          RESY_SIGN_OUT_TOOL,
        );
      }
    }
    if (chatContext?.isGroupChat) {
      tools.push(RENAME_CHAT_TOOL);
    }

    // ── Tool-use loop ──────────────────────────────────────────────────────
    let bookingSucceeded = false; // Track if a resy_book call succeeded
    const resyBookSummaries: string[] = []; // One entry per resy_book tool call, for accurate history tags
    /** Resolved venue IDs from resy_find_slots (Claude sometimes passes the wrong id — must match what we actually queried). */
    const findSlotsSummaries: string[] = [];
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
            const geo =
              input.lat != null && input.lng != null
                ? { lat: input.lat, lng: input.lng }
                : inferredGeo
                  ? { lat: inferredGeo.lat, lng: inferredGeo.lng }
                  : undefined;
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
          const tentativeVenueId = resolveVenueFromSelection(chatId, venueThreadText, input.venue_id);
          const finalVenueId = coerceVenueToCachedOnly(chatId, venueThreadText, tentativeVenueId);
          if (finalVenueId === null) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content:
                'Error finding slots: venue_id is not from the last resy_search results. Call resy_search again so venue IDs match the guest’s city (e.g. mention Miami explicitly), then use a venue_id from that response.',
              is_error: true,
            });
            findSlotsSummaries.push('[checked slots: no valid venue — re-run resy_search]');
          } else {
            if (finalVenueId !== input.venue_id) {
              console.log(`[claude] Resolved venue for slots: ${input.venue_id} -> ${finalVenueId} from thread/cache`);
            }
            const slotsSummaryLine = `[checked slots: venue ${finalVenueId}, ${input.date}, party of ${input.party_size}]`;
            try {
              const explicitGeo = input.lat != null && input.lng != null ? { lat: input.lat, lng: input.lng } : undefined;
              const geo =
                explicitGeo ?? (inferredGeo ? { lat: inferredGeo.lat, lng: inferredGeo.lng } : undefined);
              const slots = await findSlots(resyAuthToken!, finalVenueId, input.date, input.party_size, geo);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(slots) });
            } catch (error) {
              const msg = error instanceof Error ? error.message : 'Unknown error';
              console.error('[claude] resy_find_slots error:', msg);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error finding slots: ${msg}`, is_error: true });
            }
            findSlotsSummaries.push(slotsSummaryLine);
          }

        } else if (block.name === 'resy_book') {
          const input = block.input as { venue_id: number; date: string; party_size: number; time?: string };
          try {
            const tentativeVenueId = resolveVenueFromSelection(chatId, venueThreadText, input.venue_id);
            const finalVenueId = coerceVenueToCachedOnly(chatId, venueThreadText, tentativeVenueId);
            if (finalVenueId === null) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content:
                  'Error booking: venue_id is not from the last resy_search. Run resy_search for the correct city, then resy_book with an id from those results.',
                is_error: true,
              });
              resyBookSummaries.push('[resy_book did not succeed]');
            } else {
              if (finalVenueId !== input.venue_id) {
                console.log(`[claude] Resolved venue for booking: ${input.venue_id} -> ${finalVenueId} from thread/cache`);
              }
              const bookGeo = inferredGeo ? { lat: inferredGeo.lat, lng: inferredGeo.lng } : undefined;
              const confirmation = await bookReservation(
                resyAuthToken!,
                finalVenueId,
                input.date,
                input.party_size,
                input.time,
                bookGeo,
              );
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(confirmation) });
              bookingSucceeded = true;
              resyBookSummaries.push('[booked a reservation]');
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_book error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error booking reservation: ${msg}`, is_error: true });
            resyBookSummaries.push('[resy_book did not succeed]');
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

        } else if (block.name === 'doordash_create_delivery') {
          const input = block.input as {
            pickup_address: string;
            pickup_business_name: string;
            pickup_phone_number: string;
            pickup_instructions?: string;
            dropoff_address: string;
            dropoff_business_name: string;
            dropoff_phone_number: string;
            dropoff_instructions?: string;
            order_value: number;
          };
          try {
            const safeChat = chatId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || 'thread';
            const external_delivery_id = `remi-${safeChat}-${Date.now()}`;
            const orderValue = Math.round(Number(input.order_value));
            if (!Number.isFinite(orderValue) || orderValue <= 0) {
              throw new Error('order_value must be a positive integer in cents');
            }
            const body: DoorDashCreateDeliveryRequest = {
              external_delivery_id,
              pickup_address: input.pickup_address.trim(),
              pickup_business_name: input.pickup_business_name.trim(),
              pickup_phone_number: input.pickup_phone_number.trim(),
              dropoff_address: input.dropoff_address.trim(),
              dropoff_business_name: input.dropoff_business_name.trim(),
              dropoff_phone_number: input.dropoff_phone_number.trim(),
              order_value: orderValue,
            };
            if (
              !body.pickup_address
              || !body.pickup_business_name
              || !body.pickup_phone_number
              || !body.dropoff_address
              || !body.dropoff_business_name
              || !body.dropoff_phone_number
            ) {
              throw new Error('Pickup/dropoff address, business name, and phone fields must be non-empty');
            }
            if (input.pickup_instructions?.trim()) {
              body.pickup_instructions = input.pickup_instructions.trim();
            }
            if (input.dropoff_instructions?.trim()) {
              body.dropoff_instructions = input.dropoff_instructions.trim();
            }
            const result = await createDelivery(body);
            console.log(`[claude] doordash_create_delivery ok ${external_delivery_id}`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({
                ...result,
                instruction:
                  'Reply in a short, warm concierge tone. You may mention the delivery reference or status from this payload if it helps the guest; do not dump raw JSON.',
              }),
            });
          } catch (error) {
            const msg = error instanceof DoorDashApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : 'Unknown error';
            console.error('[claude] doordash_create_delivery error:', msg);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error creating DoorDash delivery: ${msg}`,
              is_error: true,
            });
          }

        } else if (block.name === 'uber_ride_link') {
          const input = block.input as {
            dropoff_formatted_address?: string;
            dropoff_nickname?: string;
            pickup_formatted_address?: string;
            pickup_my_location?: boolean;
          };
          const url = buildUberRideDeepLink({
            dropoffFormattedAddress: input.dropoff_formatted_address,
            dropoffNickname: input.dropoff_nickname,
            pickupFormattedAddress: input.pickup_formatted_address,
            pickupMyLocation: input.pickup_my_location,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({
              uber_url: url,
              instruction:
                'Include uber_url verbatim on its own line for the guest to tap. You should already have asked pickup then destination separately before calling this.',
            }),
          });

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

    // If the model skipped resy_book but the guest clearly picked a time after we showed slots, book deterministically.
    if (resyAuthToken && !bookingSucceeded && resyBookSummaries.length === 0) {
      const conv = await getConversation(chatId);
      const convLines = conv.slice(-25).map(m => m.content);
      const progThreadText = threadSnippetForGeo(userMessage.trim(), convLines);
      const pending = parsePendingSlotCheckFromHistory(conv);
      const timeHHMM = parseGuestTimeToHHMM(userMessage.trim());
      if (pending && timeHHMM) {
        const coercedVenue = coerceVenueToCachedOnly(chatId, progThreadText, pending.venueId);
        if (coercedVenue === null) {
          console.warn('[claude] Programmatic resy_book skipped: venue not in last search cache');
        } else {
          try {
            const progGeo = inferResyGeoFromText(progThreadText);
            const geoArg = progGeo ? { lat: progGeo.lat, lng: progGeo.lng } : undefined;
            const confirmation = await bookReservation(
              resyAuthToken,
              coercedVenue,
              pending.date,
              pending.partySize,
              timeHHMM,
              geoArg,
            );
            textResponse = buildBookingConfirmationText(confirmation);
            bookingSucceeded = true;
            resyBookSummaries.push('[booked a reservation]');
            console.log('[claude] Programmatic resy_book fallback succeeded');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[claude] Programmatic resy_book fallback failed:', msg);
          }
        }
      }
    }

    if (!bookingSucceeded && textImpliesConfirmedBooking(textResponse)) {
      console.warn('[claude] Replaced model text that claimed a booking without a successful resy_book');
      textResponse =
        "couldn't lock that reservation on the partner side just now — want to try that time again, or pick another?";
    }

    // After tool loop + programmatic fallback (bookingSucceeded may have flipped)
    if (bookingSucceeded && !effect) {
      effect = { type: 'screen', name: 'celebration' };
      console.log('[claude] Auto-attaching celebration effect for successful booking');
    }

    // Build a summary of tool calls for conversation history
    // This lets Claude reference prior searches, bookings, etc. in follow-up messages
    const toolSummaryParts: string[] = [];
    let resyBookSummaryIdx = 0;
    let findSlotsSummaryIdx = 0;
    for (const block of allBlocks) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'resy_search') {
        const input = block.input as { query: string };
        toolSummaryParts.push(`[searched resy for "${input.query}"]`);
      } else if (block.name === 'resy_find_slots') {
        toolSummaryParts.push(findSlotsSummaries[findSlotsSummaryIdx++] ?? '[checked slots]');
      } else if (block.name === 'resy_book') {
        toolSummaryParts.push(resyBookSummaries[resyBookSummaryIdx++] ?? '[resy_book]');
      } else if (block.name === 'resy_cancel') {
        toolSummaryParts.push(`[cancelled a reservation]`);
      } else if (block.name === 'resy_reservations') {
        toolSummaryParts.push(`[checked upcoming reservations]`);
      } else if (block.name === 'resy_profile') {
        toolSummaryParts.push(`[checked resy profile]`);
      } else if (block.name === 'resy_sign_out') {
        toolSummaryParts.push(`[signed out of resy]`);
      } else if (block.name === 'uber_ride_link') {
        toolSummaryParts.push(`[shared uber ride link]`);
      } else if (block.name === 'doordash_create_delivery') {
        toolSummaryParts.push(`[created doordash delivery]`);
      }
    }
    while (resyBookSummaryIdx < resyBookSummaries.length) {
      toolSummaryParts.push(resyBookSummaries[resyBookSummaryIdx++]);
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
