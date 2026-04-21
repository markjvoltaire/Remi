// Templated user-facing strings for the booking pipeline.
// These are the ONLY way booking messages reach the guest — never free-form LLM text.

import type { ResyBookingConfirmation } from '../bookings/types.js';
import type { PendingBooking } from './state.js';

function formatDate(yyyyMmDd: string): string {
  // Parse without timezone drift (treat as local calendar day)
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  if (!y || !m || !d) return yyyyMmDd;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const period = h >= 12 ? 'pm' : 'am';
  const hour12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${hour12}${period}` : `${hour12}:${m.toString().padStart(2, '0')}${period}`;
}

export function proposalExactTime(p: PendingBooking): string {
  return [
    `${p.venueName} — ${formatDate(p.date)} at ${formatTime(p.bookedTime)}, ${p.partySize} ${p.partySize === 1 ? 'guest' : 'guests'}.`,
    `Shall I lock it in?`,
  ].join('\n---\n');
}

export function proposalWithNearestTime(p: PendingBooking): string {
  return [
    `${formatTime(p.requestedTime)} at ${p.venueName} isn't available, but ${formatTime(p.bookedTime)} on ${formatDate(p.date)} is — ${p.partySize} ${p.partySize === 1 ? 'guest' : 'guests'}.`,
    `Shall I lock that in?`,
  ].join('\n---\n');
}

export function disambiguation(
  restaurantQuery: string,
  options: Array<{ name: string; city?: string; neighborhood?: string }>,
): string {
  const bullets = options.slice(0, 3).map(o => {
    const where = o.neighborhood ? `${o.neighborhood}, ${o.city ?? ''}`.replace(/, $/, '') : o.city;
    return where ? `${o.name} — ${where}` : o.name;
  });
  return [
    `A few places match "${restaurantQuery}". Which did you mean?`,
    ...bullets,
  ].join('\n---\n');
}

export function noSameDayAvailability(
  venueName: string,
  date: string,
  partySize: number,
): string {
  return `${venueName} is fully committed on ${formatDate(date)} for ${partySize} ${partySize === 1 ? 'guest' : 'guests'}. Want to try a different day?`;
}

export function venueNotFound(query: string): string {
  return `I couldn't find ${query} on Resy. Want me to try a different spelling or a similar spot?`;
}

export function missingDetails(missing: { date?: boolean; partySize?: boolean; time?: boolean }): string {
  const parts: string[] = [];
  if (missing.date) parts.push('what day');
  if (missing.partySize) parts.push('how many guests');
  if (missing.time) parts.push('what time');
  if (parts.length === 0) return `I need one more detail to lock that in.`;
  return `Happy to handle that — ${parts.join(' and ')}?`;
}

export function bookingSuccess(c: ResyBookingConfirmation, requestedTime?: string): string {
  const time = typeof c.time === 'string' && /^\d{2}:\d{2}/.test(c.time)
    ? formatTime(c.time.slice(0, 5))
    : c.time;
  const nearestNote = requestedTime && requestedTime !== (typeof c.time === 'string' ? c.time.slice(0, 5) : '')
    ? ` (nearest to your ${formatTime(requestedTime)})`
    : '';
  return [
    `It's handled.`,
    `${c.venue_name} — ${formatDate(c.date)} at ${time}${nearestNote}, ${c.party_size} ${c.party_size === 1 ? 'guest' : 'guests'}.`,
    c.venue_url,
  ].join('\n---\n');
}

export function bookingFailed(reason?: string): string {
  if (reason && /payment/i.test(reason)) {
    return `Couldn't complete the booking — no card on file with our reservation partner. Once you've added one, message me and I'll lock it in.`;
  }
  return `Couldn't lock that table just now — want me to try another time or spot?`;
}

export function pendingExpired(): string {
  return `That hold timed out. Want me to find a fresh time?`;
}
