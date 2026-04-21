// NLU for the booking pipeline. Regex-first for deterministic fields
// (time, date, party size, confirmation), then a Claude JSON-schema call
// to extract restaurant name, city, and action.

import Anthropic from '@anthropic-ai/sdk';
import type { StoredMessage } from '../state/conversation.js';

const client = new Anthropic();

export type BookingAction =
  | 'book'        // Guest is asking to create/search a new reservation
  | 'confirm'     // Guest is confirming a pending proposal (yes / book it)
  | 'cancel'      // Cancel an existing reservation
  | 'modify'      // Change an existing pending proposal (different time/date)
  | 'none';       // Not a booking-related message

export interface BookingIntent {
  action: BookingAction;
  restaurant: string | null;   // e.g. "Carbone"
  city: string | null;         // e.g. "Miami", "New York"
  date: string | null;         // YYYY-MM-DD
  time: string | null;         // HH:MM (24h)
  partySize: number | null;
  /** True if the latest message looks like a yes/confirm ("yeah", "book it"). */
  hasConfirmSignal: boolean;
  /** True if the latest message looks like a no/cancel ("nevermind", "stop"). */
  hasRejectSignal: boolean;
}

// ─── Regex extractors ──────────────────────────────────────────────────────

const CONFIRM_RE = /^(?:yes|yeah|yep|yup|sure|ok|okay|ya|ye|confirm(?:ed)?|book it|do it|lock it in|lock it|go for it|go ahead|please do|let'?s do it|sounds good|perfect|great|please)\b[\s.!]*$/i;
const REJECT_RE = /^(?:no|nope|nah|cancel|stop|nevermind|never mind|forget it|hold off|don'?t)\b[\s.!]*$/i;

export function parseConfirmSignal(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  return CONFIRM_RE.test(t);
}

export function parseRejectSignal(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  return REJECT_RE.test(t);
}

export function parseTimeToHHMM(message: string): string | null {
  const t = message.toLowerCase();
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

export function parsePartySize(message: string): number | null {
  const t = message.toLowerCase();
  if (!t) return null;

  // "party of 4", "for 4", "table for 2", "2 people", "2 guests"
  const patterns: RegExp[] = [
    /\b(?:party of|table for|for|of)\s+(\d{1,2})\b/,
    /\b(\d{1,2})\s+(?:people|guests?|ppl|persons?|pax|tops?|covers)\b/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 40) return n;
    }
  }

  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    single: 1, solo: 1, couple: 2, duo: 2,
  };
  // "for two", "for a couple", "party of four", etc.
  const m1 = t.match(/\b(?:for|of)\s+(?:a\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|single|solo|couple|duo)\b/);
  if (m1) return words[m1[1]] ?? null;
  const m2 = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|single|solo|couple|duo)\s+(?:people|guests?|ppl|top|tops|covers)\b/);
  if (m2) return words[m2[1]] ?? null;

  return null;
}

/**
 * Resolve a date from the user's message against a reference date (today).
 * Handles: today, tomorrow, tonight, this/next <weekday>, <weekday>, YYYY-MM-DD, Month D.
 */
export function parseDate(message: string, now: Date = new Date()): string | null {
  const t = message.toLowerCase();
  if (!t) return null;

  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (/\b(today|tonight)\b/.test(t)) return fmt(today);
  if (/\btomorrow\b/.test(t)) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return fmt(d);
  }

  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayRe = new RegExp(`\\b(this|next)?\\s*(${dayNames.join('|')})\\b`);
  const dayMatch = t.match(dayRe);
  if (dayMatch) {
    const modifier = dayMatch[1];
    const target = dayNames.indexOf(dayMatch[2]);
    const current = today.getDay();
    let diff = target - current;
    if (modifier === 'next') {
      if (diff <= 0) diff += 7;
      diff += 7;
    } else {
      // "this Friday" or bare "Friday" — next occurrence (including today if today matches)
      if (diff < 0) diff += 7;
      if (diff === 0 && modifier !== 'this') {
        // Bare "Monday" on a Monday could mean today; keep today
      }
    }
    const d = new Date(today);
    d.setDate(d.getDate() + diff);
    return fmt(d);
  }

  // "April 25", "Apr 25", "4/25"
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const monthRe = new RegExp(`\\b(${months.join('|')}|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\\.?\\s+(\\d{1,2})\\b`);
  const monthMatch = t.match(monthRe);
  if (monthMatch) {
    const monToken = monthMatch[1].toLowerCase();
    const monIdx = months.findIndex(m => m.startsWith(monToken.replace('.', '')));
    const day = parseInt(monthMatch[2], 10);
    if (monIdx >= 0 && day >= 1 && day <= 31) {
      let year = today.getFullYear();
      const candidate = new Date(year, monIdx, day);
      if (candidate < today) year += 1;
      return fmt(new Date(year, monIdx, day));
    }
  }

  const slash = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const m = parseInt(slash[1], 10);
    const d = parseInt(slash[2], 10);
    let y = slash[3] ? parseInt(slash[3], 10) : today.getFullYear();
    if (y < 100) y += 2000;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const candidate = new Date(y, m - 1, d);
      if (!slash[3] && candidate < today) y += 1;
      return fmt(new Date(y, m - 1, d));
    }
  }

  return null;
}

// ─── Claude extractor for restaurant + action ──────────────────────────────

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'extract_booking_intent',
  description: 'Extract structured booking intent from the guest\'s latest message, using the conversation history only for context when the latest message references "it", "that", "there", etc.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['book', 'confirm', 'cancel', 'modify', 'none'],
        description: [
          '"book": guest wants to create or search for a reservation (mentions a restaurant, time, or explicit request)',
          '"confirm": guest is saying yes/go ahead on a specific proposal',
          '"cancel": guest wants to cancel an existing or pending reservation',
          '"modify": guest wants to change a pending proposal (different time/date/restaurant)',
          '"none": not booking-related (chit-chat, onboarding, profile, etc.)',
        ].join('\n'),
      },
      restaurant: {
        type: ['string', 'null'],
        description: 'The restaurant name the guest mentioned MOST RECENTLY in their latest message. Null if they did not name one.',
      },
      city: {
        type: ['string', 'null'],
        description: 'City the guest referenced (e.g. "Miami", "New York", "Los Angeles"). Null if not specified.',
      },
    },
    required: ['action', 'restaurant', 'city'],
  },
} as unknown as Anthropic.Tool;

function buildHistoryBlock(history: StoredMessage[]): string {
  const slice = history.slice(-10);
  if (slice.length === 0) return '(no prior messages)';
  return slice
    .map(m => `${m.role === 'assistant' ? 'Remi' : 'Guest'}: ${m.content}`)
    .join('\n');
}

async function extractRestaurantAndAction(
  message: string,
  history: StoredMessage[],
): Promise<{ action: BookingAction; restaurant: string | null; city: string | null }> {
  const system = `You extract structured booking intent for a concierge texting app. Only use the latest guest message to decide \`restaurant\` — never pull a restaurant name from history unless the latest message explicitly refers to it (e.g. "that one", "it"). If the guest changes their mind ("actually, Carbone instead"), restaurant = "Carbone".`;
  const user = `History (most recent last):\n${buildHistoryBlock(history)}\n\nLatest guest message: "${message}"\n\nCall extract_booking_intent.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      system,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_booking_intent' },
      messages: [{ role: 'user', content: user }],
    });
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'extract_booking_intent') {
        const input = block.input as { action?: string; restaurant?: string | null; city?: string | null };
        const action: BookingAction = (
          ['book', 'confirm', 'cancel', 'modify', 'none'].includes(input.action ?? '')
            ? (input.action as BookingAction)
            : 'none'
        );
        return {
          action,
          restaurant: typeof input.restaurant === 'string' && input.restaurant.trim() ? input.restaurant.trim() : null,
          city: typeof input.city === 'string' && input.city.trim() ? input.city.trim() : null,
        };
      }
    }
  } catch (err) {
    console.error('[nlu] extract_booking_intent error:', err instanceof Error ? err.message : err);
  }
  return { action: 'none', restaurant: null, city: null };
}

export async function extractBookingIntent(
  message: string,
  history: StoredMessage[],
  now: Date = new Date(),
): Promise<BookingIntent> {
  const confirm = parseConfirmSignal(message);
  const reject = parseRejectSignal(message);
  const time = parseTimeToHHMM(message);
  const date = parseDate(message, now);
  const partySize = parsePartySize(message);

  // Shortcut: pure confirmation/rejection doesn't need the LLM.
  if ((confirm || reject) && !time && !date && partySize == null) {
    return {
      action: confirm ? 'confirm' : 'cancel',
      restaurant: null,
      city: null,
      date,
      time,
      partySize,
      hasConfirmSignal: confirm,
      hasRejectSignal: reject,
    };
  }

  const { action, restaurant, city } = await extractRestaurantAndAction(message, history);

  return {
    action,
    restaurant,
    city,
    date,
    time,
    partySize,
    hasConfirmSignal: confirm,
    hasRejectSignal: reject,
  };
}

/** Pick up a restaurant name across the last few user messages when the latest one omits it. */
export function lastMentionedRestaurantFromHistory(history: StoredMessage[]): string | null {
  // Cheap heuristic only used as a fallback. The pipeline prefers the NLU result.
  for (let i = history.length - 1; i >= 0 && i >= history.length - 6; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const match = m.content.match(/\b(?:at|to|@)\s+([A-Z][A-Za-z'&. -]{2,40})\b/);
    if (match) return match[1].trim();
  }
  return null;
}
