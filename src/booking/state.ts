// Short-lived state for the deterministic booking pipeline.
// A PendingBooking is created when Remi proposes a specific table to the guest
// and consumed (deleted) when the guest confirms or the proposal expires.

import { getItem, putItem, deleteItem } from '../db/storage.js';

const PENDING_BOOKING_PK_PREFIX = 'PENDING_BOOK#';
const PENDING_BOOKING_SK = 'PENDING_BOOK';

const PROPOSAL_TTL_S = 15 * 60;

export interface PendingBooking {
  venueId: number;
  venueName: string;
  venueUrl?: string;
  date: string;           // YYYY-MM-DD
  partySize: number;
  requestedTime: string;  // HH:MM — what the guest asked for
  bookedTime: string;     // HH:MM — nearest available on same date
  slotType: string;       // "Dining Room", "Bar", etc.
  configToken: string;    // Resy config_token for the selected slot
  city?: string;          // Human-readable city label (e.g. "Miami")
  createdAt: number;
  expiresAt: number;
}

export async function getPendingBooking(chatId: string): Promise<PendingBooking | null> {
  const record = await getItem<PendingBooking>(`${PENDING_BOOKING_PK_PREFIX}${chatId}`, PENDING_BOOKING_SK);
  if (!record) return null;
  if (typeof record.expiresAt === 'number' && record.expiresAt < Date.now()) {
    await deleteItem(`${PENDING_BOOKING_PK_PREFIX}${chatId}`, PENDING_BOOKING_SK).catch(() => undefined);
    return null;
  }
  return record;
}

export async function setPendingBooking(
  chatId: string,
  draft: Omit<PendingBooking, 'createdAt' | 'expiresAt'>,
): Promise<PendingBooking> {
  const now = Date.now();
  const record: PendingBooking = {
    ...draft,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_S * 1000,
  };
  await putItem(
    `${PENDING_BOOKING_PK_PREFIX}${chatId}`,
    PENDING_BOOKING_SK,
    record as unknown as Record<string, unknown>,
    PROPOSAL_TTL_S,
  );
  return record;
}

export async function clearPendingBooking(chatId: string): Promise<void> {
  await deleteItem(`${PENDING_BOOKING_PK_PREFIX}${chatId}`, PENDING_BOOKING_SK);
}
