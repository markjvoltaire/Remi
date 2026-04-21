// Deterministic booking pipeline.
// Owns: search -> venue resolve -> slots -> propose -> confirm -> book.
// Claude is used for NLU only (via ./nlu.ts); it never picks venue IDs or
// triggers resy_book. That guarantees the message the guest confirms is
// exactly what gets booked.

import type { StoredMessage } from '../state/conversation.js';
import {
  searchRestaurants,
  findSlots,
  findNearestSameDaySlot,
  bookReservation,
  ResyAuthError,
} from '../bookings/client.js';
import type { ResyVenue, ResyBookingConfirmation, ResyTimeSlot } from '../bookings/types.js';
import { inferResyGeoFromText, threadSnippetForGeo } from '../bookings/geo.js';
import type { BookingIntent } from './nlu.js';
import {
  getPendingBooking,
  setPendingBooking,
  clearPendingBooking,
  type PendingBooking,
} from './state.js';
import {
  proposalExactTime,
  proposalWithNearestTime,
  disambiguation,
  noSameDayAvailability,
  venueNotFound,
  missingDetails,
  bookingSuccess,
  bookingFailed,
  pendingExpired,
} from './messages.js';

export interface PipelineInput {
  chatId: string;
  userMessage: string;
  history: StoredMessage[];
  intent: BookingIntent;
  resyAuthToken: string;
  now?: Date;
}

export interface PipelineResult {
  text: string;
  bookingConfirmation?: ResyBookingConfirmation;
  /** True when the pipeline produced a booking; caller can attach celebration effect. */
  booked: boolean;
  /** True if the pipeline took ownership of the turn. False means fall back to Claude. */
  handled: boolean;
}

const NOT_HANDLED: PipelineResult = { text: '', booked: false, handled: false };

// ─── Public entry point ────────────────────────────────────────────────────

export async function handleBookingTurn(input: PipelineInput): Promise<PipelineResult> {
  const { intent, chatId } = input;

  if (intent.hasRejectSignal) {
    const pending = await getPendingBooking(chatId);
    if (pending) {
      await clearPendingBooking(chatId);
      return handled('No problem — happy to look at something else whenever you\'re ready.');
    }
    // Not our turn — let Claude handle "no" in general conversation.
    return NOT_HANDLED;
  }

  if (intent.action === 'confirm' || intent.hasConfirmSignal) {
    return await handleConfirmation(input);
  }

  if (intent.action === 'book' || intent.action === 'modify') {
    return await handleBookOrModify(input);
  }

  return NOT_HANDLED;
}

// ─── Confirmation path ─────────────────────────────────────────────────────

async function handleConfirmation(input: PipelineInput): Promise<PipelineResult> {
  const { chatId, resyAuthToken, intent } = input;
  const pending = await getPendingBooking(chatId);
  if (!pending) {
    // Confirmation signal without a proposal on record. Let Claude handle it
    // conversationally rather than guessing.
    return NOT_HANDLED;
  }

  // Safety: if the user confirms but names a DIFFERENT restaurant or a different
  // date/time/party size, treat as a modification and re-run the pipeline.
  if (intentDivergesFromPending(intent, pending)) {
    await clearPendingBooking(chatId);
    return await handleBookOrModify(input);
  }

  try {
    const confirmation = await bookReservation({
      authToken: resyAuthToken,
      venueId: pending.venueId,
      day: pending.date,
      partySize: pending.partySize,
      configToken: pending.configToken,
      bookedTime: pending.bookedTime,
      requestedTime: pending.requestedTime,
    });
    await clearPendingBooking(chatId);
    return {
      text: bookingSuccess(confirmation, pending.requestedTime),
      bookingConfirmation: confirmation,
      booked: true,
      handled: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Stale config_token — re-pick a fresh slot on the same date and re-propose.
    if (/config|token|expired|unavailable|no longer/i.test(msg)) {
      console.warn('[pipeline] Stale proposal, re-picking slot:', msg);
      const refreshed = await repickAndProposeFromPending(chatId, resyAuthToken, pending);
      if (refreshed) return refreshed;
    }

    if (err instanceof ResyAuthError) {
      return handled(err.message);
    }

    console.error('[pipeline] Confirmation book error:', msg);
    return handled(bookingFailed(msg));
  }
}

async function repickAndProposeFromPending(
  chatId: string,
  resyAuthToken: string,
  pending: PendingBooking,
): Promise<PipelineResult | null> {
  const geo = pending.city ? inferResyGeoFromText(pending.city) : undefined;
  let slots: ResyTimeSlot[];
  try {
    slots = await findSlots(resyAuthToken, pending.venueId, pending.date, pending.partySize, geo);
  } catch (err) {
    console.error('[pipeline] Slot refresh failed:', err instanceof Error ? err.message : err);
    return null;
  }

  if (slots.length === 0) {
    await clearPendingBooking(chatId);
    return handled(noSameDayAvailability(pending.venueName, pending.date, pending.partySize));
  }

  const nearest = findNearestSameDaySlot(slots, pending.requestedTime);
  if (!nearest) {
    await clearPendingBooking(chatId);
    return handled(noSameDayAvailability(pending.venueName, pending.date, pending.partySize));
  }

  const refreshed = await setPendingBooking(chatId, {
    venueId: pending.venueId,
    venueName: pending.venueName,
    venueUrl: pending.venueUrl,
    date: pending.date,
    partySize: pending.partySize,
    requestedTime: pending.requestedTime,
    bookedTime: nearest.slot.time,
    slotType: nearest.slot.type,
    configToken: nearest.slot.config_token,
    city: pending.city,
  });

  const text = refreshed.bookedTime === refreshed.requestedTime
    ? proposalExactTime(refreshed)
    : proposalWithNearestTime(refreshed);
  return handled(`${pendingExpired()}\n---\n${text}`);
}

// ─── Book / modify path ────────────────────────────────────────────────────

async function handleBookOrModify(input: PipelineInput): Promise<PipelineResult> {
  const { chatId, userMessage, history, intent, resyAuthToken } = input;

  // Merge with any pending proposal so we can carry forward details the guest
  // already provided (e.g. "actually 8pm" with no restaurant/date reset).
  const pending = await getPendingBooking(chatId);
  const merged = mergeIntentWithPending(intent, pending, history);

  if (!merged.restaurant) {
    return NOT_HANDLED; // Let Claude ask for a restaurant conversationally.
  }

  // If the guest switched restaurants, clear any stale proposal.
  if (pending && normalizeName(pending.venueName) !== normalizeName(merged.restaurant)) {
    await clearPendingBooking(chatId);
  }

  const missing: { date?: boolean; partySize?: boolean; time?: boolean } = {};
  if (!merged.date) missing.date = true;
  if (!merged.partySize) missing.partySize = true;
  if (!merged.time) missing.time = true;
  if (missing.date || missing.partySize || missing.time) {
    return handled(missingDetails(missing));
  }

  const threadText = threadSnippetForGeo(userMessage, history.slice(-10).map(m => m.content));
  const geo = merged.city
    ? inferResyGeoFromText(merged.city, threadText) ?? inferResyGeoFromText(threadText)
    : inferResyGeoFromText(threadText);

  // 1. Search for the venue.
  let hits: ResyVenue[];
  try {
    hits = await searchRestaurants(resyAuthToken, merged.restaurant, geo ? { lat: geo.lat, lng: geo.lng } : undefined);
  } catch (err) {
    if (err instanceof ResyAuthError) return handled(err.message);
    console.error('[pipeline] search error:', err instanceof Error ? err.message : err);
    return handled(bookingFailed());
  }

  const resolved = resolveVenue(hits, merged.restaurant, merged.city);
  if (!resolved) {
    return handled(venueNotFound(merged.restaurant));
  }
  if (resolved.kind === 'ambiguous') {
    return handled(disambiguation(merged.restaurant, resolved.candidates.map(v => ({
      name: v.name,
      city: v.location.city,
      neighborhood: v.location.neighborhood,
    }))));
  }

  const venue = resolved.venue;

  // 2. Find slots on the requested date.
  let slots: ResyTimeSlot[];
  try {
    slots = await findSlots(resyAuthToken, venue.venue_id, merged.date!, merged.partySize!, geo ? { lat: geo.lat, lng: geo.lng } : undefined);
  } catch (err) {
    if (err instanceof ResyAuthError) return handled(err.message);
    console.error('[pipeline] findSlots error:', err instanceof Error ? err.message : err);
    return handled(bookingFailed());
  }

  if (slots.length === 0) {
    await clearPendingBooking(chatId);
    return handled(noSameDayAvailability(venue.name, merged.date!, merged.partySize!));
  }

  // 3. Pick the nearest time on that same date (never drift to another day).
  const nearest = findNearestSameDaySlot(slots, merged.time!);
  if (!nearest) {
    await clearPendingBooking(chatId);
    return handled(noSameDayAvailability(venue.name, merged.date!, merged.partySize!));
  }

  // 4. Persist the proposal.
  const proposal = await setPendingBooking(chatId, {
    venueId: venue.venue_id,
    venueName: venue.name,
    venueUrl: venue.url,
    date: merged.date!,
    partySize: merged.partySize!,
    requestedTime: merged.time!,
    bookedTime: nearest.slot.time,
    slotType: nearest.slot.type,
    configToken: nearest.slot.config_token,
    city: merged.city ?? venue.location.city,
  });

  const text = proposal.bookedTime === proposal.requestedTime
    ? proposalExactTime(proposal)
    : proposalWithNearestTime(proposal);
  return handled(text);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function handled(text: string): PipelineResult {
  return { text, booked: false, handled: true };
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface MergedIntent {
  restaurant: string | null;
  city: string | null;
  date: string | null;
  time: string | null;
  partySize: number | null;
}

function mergeIntentWithPending(
  intent: BookingIntent,
  pending: PendingBooking | null,
  history: StoredMessage[],
): MergedIntent {
  // Prefer the latest message; fall back to the pending proposal (so the guest
  // can say "actually 7pm" without re-supplying everything), then to history.
  const restaurant = intent.restaurant
    ?? (pending ? pending.venueName : null)
    ?? restaurantFromRecentHistory(history);
  return {
    restaurant,
    city: intent.city ?? pending?.city ?? null,
    date: intent.date ?? pending?.date ?? null,
    time: intent.time ?? pending?.requestedTime ?? null,
    partySize: intent.partySize ?? pending?.partySize ?? null,
  };
}

function restaurantFromRecentHistory(history: StoredMessage[]): string | null {
  // Very light fallback. The NLU is expected to have already picked it up in
  // most cases; this only helps when "restaurant" comes from an assistant
  // message and the guest replied with just a time.
  for (let i = history.length - 1; i >= Math.max(0, history.length - 8); i--) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    const match = m.content.match(/\b([A-Z][A-Za-z'&. -]{2,40})\s+—/);
    if (match) return match[1].trim();
  }
  return null;
}

function intentDivergesFromPending(intent: BookingIntent, pending: PendingBooking): boolean {
  if (intent.restaurant && normalizeName(intent.restaurant) !== normalizeName(pending.venueName)) return true;
  if (intent.date && intent.date !== pending.date) return true;
  if (intent.time && intent.time !== pending.requestedTime) return true;
  if (intent.partySize != null && intent.partySize !== pending.partySize) return true;
  return false;
}

type VenueResolution =
  | { kind: 'resolved'; venue: ResyVenue }
  | { kind: 'ambiguous'; candidates: ResyVenue[] }
  | null;

function resolveVenue(
  hits: ResyVenue[],
  query: string,
  cityHint: string | null,
): VenueResolution {
  if (!hits.length) return null;

  const normQuery = normalizeName(query);
  const exactName = hits.filter(h => normalizeName(h.name) === normQuery);
  const pool = exactName.length > 0 ? exactName : hits.filter(h => normalizeName(h.name).includes(normQuery));

  if (pool.length === 0) {
    // Query didn't match any hit by name — refuse rather than pick an unrelated venue.
    return null;
  }

  let candidates = pool;
  if (cityHint) {
    const cityNorm = normalizeName(cityHint);
    const byCity = pool.filter(v => normalizeName(`${v.location.city} ${v.location.state}`).includes(cityNorm));
    if (byCity.length > 0) candidates = byCity;
  }

  if (candidates.length === 1) {
    return { kind: 'resolved', venue: candidates[0] };
  }

  // Multiple matches in the same city (or no city hint): only accept a unique
  // exact-name match. Otherwise ask the guest to disambiguate.
  const exactInCandidates = candidates.filter(v => normalizeName(v.name) === normQuery);
  if (exactInCandidates.length === 1) {
    return { kind: 'resolved', venue: exactInCandidates[0] };
  }

  return { kind: 'ambiguous', candidates: candidates.slice(0, 3) };
}
