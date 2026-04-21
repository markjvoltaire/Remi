import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResyVenue, ResyTimeSlot, ResyBookingConfirmation } from '../../bookings/types.js';

// ─── Mocks ───────────────────────────────────────────────────────────────

const mockSearch = vi.fn<(...args: unknown[]) => Promise<ResyVenue[]>>();
const mockFindSlots = vi.fn<(...args: unknown[]) => Promise<ResyTimeSlot[]>>();
const mockBookReservation = vi.fn<(...args: unknown[]) => Promise<ResyBookingConfirmation>>();

vi.mock('../../bookings/client.js', async () => {
  // Import the real implementation for pure helpers, but stub the network calls.
  const actual = await vi.importActual<typeof import('../../bookings/client.js')>('../../bookings/client.js');
  return {
    ...actual,
    searchRestaurants: (...args: unknown[]) => mockSearch(...args),
    findSlots: (...args: unknown[]) => mockFindSlots(...args),
    bookReservation: (...args: unknown[]) => mockBookReservation(...args),
  };
});

const mockGetPending = vi.fn();
const mockSetPending = vi.fn();
const mockClearPending = vi.fn();

vi.mock('../../booking/state.js', () => ({
  getPendingBooking: (...args: unknown[]) => mockGetPending(...args),
  setPendingBooking: (...args: unknown[]) => mockSetPending(...args),
  clearPendingBooking: (...args: unknown[]) => mockClearPending(...args),
}));

import { handleBookingTurn } from '../../booking/pipeline.js';
import type { BookingIntent } from '../../booking/nlu.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

const carbone: ResyVenue = {
  venue_id: 555,
  name: 'Carbone',
  location: { city: 'New York', state: 'NY' },
  cuisine: ['Italian'],
  price_range: 4,
  url_slug: 'carbone-new-york',
  url: 'https://resy.com/cities/new-york/carbone-new-york',
};

const charlieBird: ResyVenue = {
  venue_id: 999,
  name: 'Charlie Bird',
  location: { city: 'New York', state: 'NY' },
  cuisine: ['American'],
  price_range: 3,
  url_slug: 'charlie-bird',
  url: 'https://resy.com/cities/new-york/charlie-bird',
};

function intent(partial: Partial<BookingIntent> = {}): BookingIntent {
  return {
    action: 'book',
    restaurant: null,
    city: null,
    date: null,
    time: null,
    partySize: null,
    hasConfirmSignal: false,
    hasRejectSignal: false,
    ...partial,
  };
}

beforeEach(() => {
  mockSearch.mockReset();
  mockFindSlots.mockReset();
  mockBookReservation.mockReset();
  mockGetPending.mockReset().mockResolvedValue(null);
  mockSetPending.mockReset().mockImplementation(async (_chatId: string, draft: unknown) => ({
    ...(draft as object),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  }));
  mockClearPending.mockReset().mockResolvedValue(undefined);
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('handleBookingTurn — happy path', () => {
  it('searches, finds nearest slot on same date, and proposes', async () => {
    mockSearch.mockResolvedValueOnce([carbone]);
    mockFindSlots.mockResolvedValueOnce([
      { config_token: 'tok-730', date: '2026-04-24', time: '19:30', party_size: 2, type: 'Dining Room' },
    ]);

    const result = await handleBookingTurn({
      chatId: 'chat-1',
      userMessage: 'Carbone Friday 7:30pm for 2',
      history: [],
      intent: intent({
        action: 'book',
        restaurant: 'Carbone',
        city: 'New York',
        date: '2026-04-24',
        time: '19:30',
        partySize: 2,
      }),
      resyAuthToken: 'tok',
    });

    expect(result.handled).toBe(true);
    expect(result.booked).toBe(false);
    expect(result.text).toContain('Carbone');
    expect(result.text).toContain('7:30pm');
    expect(mockSetPending).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      venueId: 555,
      venueName: 'Carbone',
      bookedTime: '19:30',
      requestedTime: '19:30',
      configToken: 'tok-730',
    }));
    expect(mockBookReservation).not.toHaveBeenCalled();
  });
});

describe('handleBookingTurn — venue guard (regression for Carbone/Charlie Bird)', () => {
  it('never stores a different venue than the guest asked for', async () => {
    // Resy returns Charlie Bird FIRST even though we asked for Carbone (simulate a noisy search).
    mockSearch.mockResolvedValueOnce([charlieBird, carbone]);
    mockFindSlots.mockResolvedValueOnce([
      { config_token: 'tok-730', date: '2026-04-24', time: '19:30', party_size: 2, type: 'Dining Room' },
    ]);

    const result = await handleBookingTurn({
      chatId: 'chat-1',
      userMessage: 'Carbone Friday 7:30pm for 2',
      history: [],
      intent: intent({
        action: 'book',
        restaurant: 'Carbone',
        city: 'New York',
        date: '2026-04-24',
        time: '19:30',
        partySize: 2,
      }),
      resyAuthToken: 'tok',
    });

    expect(result.handled).toBe(true);
    // The pipeline must ignore Charlie Bird and pick Carbone by name match.
    expect(mockSetPending).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      venueId: 555,
      venueName: 'Carbone',
    }));
    // Slot lookup must use the Carbone venue_id, not Charlie Bird's.
    expect(mockFindSlots.mock.calls[0][0]).toBe('tok');
    expect(mockFindSlots.mock.calls[0][1]).toBe(555);
    expect(mockFindSlots.mock.calls[0][2]).toBe('2026-04-24');
    expect(mockFindSlots.mock.calls[0][3]).toBe(2);
  });

  it('clears pending proposal when the guest switches restaurants mid-flow', async () => {
    mockGetPending.mockResolvedValueOnce({
      venueId: 999,
      venueName: 'Charlie Bird',
      date: '2026-04-24',
      partySize: 2,
      requestedTime: '19:30',
      bookedTime: '20:00',
      slotType: 'Dining Room',
      configToken: 'old-token',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    mockSearch.mockResolvedValueOnce([carbone]);
    mockFindSlots.mockResolvedValueOnce([
      { config_token: 'tok-730', date: '2026-04-24', time: '19:30', party_size: 2, type: 'Dining Room' },
    ]);

    await handleBookingTurn({
      chatId: 'chat-1',
      userMessage: 'actually Carbone instead',
      history: [],
      intent: intent({
        action: 'modify',
        restaurant: 'Carbone',
        city: 'New York',
        date: '2026-04-24',
        time: '19:30',
        partySize: 2,
      }),
      resyAuthToken: 'tok',
    });

    expect(mockClearPending).toHaveBeenCalledWith('chat-1');
    expect(mockSetPending).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      venueId: 555,
      venueName: 'Carbone',
    }));
  });
});

describe('handleBookingTurn — nearest time delta', () => {
  it('proposes the nearest same-day slot and surfaces the delta in text', async () => {
    mockSearch.mockResolvedValueOnce([carbone]);
    mockFindSlots.mockResolvedValueOnce([
      { config_token: 'tok-715', date: '2026-04-24', time: '19:15', party_size: 2, type: 'Dining Room' },
      { config_token: 'tok-745', date: '2026-04-24', time: '19:45', party_size: 2, type: 'Dining Room' },
    ]);

    const result = await handleBookingTurn({
      chatId: 'chat-1',
      userMessage: 'Carbone Friday 7:30pm for 2',
      history: [],
      intent: intent({
        action: 'book',
        restaurant: 'Carbone',
        city: 'New York',
        date: '2026-04-24',
        time: '19:30',
        partySize: 2,
      }),
      resyAuthToken: 'tok',
    });

    expect(result.text).toContain('7:30pm');
    expect(result.text.toLowerCase()).toContain("isn't available");
    // Either 7:15 or 7:45 is equally close; our deterministic pick is the first in the list (7:15).
    expect(mockSetPending).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      bookedTime: '19:15',
      requestedTime: '19:30',
      configToken: 'tok-715',
    }));
  });
});

describe('handleBookingTurn — no same-day availability', () => {
  it('tells the guest the day is fully committed and never drifts to another date', async () => {
    mockSearch.mockResolvedValueOnce([carbone]);
    mockFindSlots.mockResolvedValueOnce([]);

    const result = await handleBookingTurn({
      chatId: 'chat-1',
      userMessage: 'Carbone Friday 7:30pm for 2',
      history: [],
      intent: intent({
        action: 'book',
        restaurant: 'Carbone',
        city: 'New York',
        date: '2026-04-24',
        time: '19:30',
        partySize: 2,
      }),
      resyAuthToken: 'tok',
    });

    expect(result.handled).toBe(true);
    expect(result.booked).toBe(false);
    expect(result.text).toContain('Carbone');
    expect(result.text.toLowerCase()).toContain('fully committed');
    expect(mockSetPending).not.toHaveBeenCalled();
    expect(mockBookReservation).not.toHaveBeenCalled();
  });
});

describe('handleBookingTurn — confirmation uses the pending proposal verbatim', () => {
  it('books exactly what was proposed, not what Claude might paraphrase', async () => {
    mockGetPending.mockResolvedValueOnce({
      venueId: 555,
      venueName: 'Carbone',
      date: '2026-04-24',
      partySize: 2,
      requestedTime: '19:30',
      bookedTime: '19:30',
      slotType: 'Dining Room',
      configToken: 'tok-730',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    mockBookReservation.mockResolvedValueOnce({
      resy_token: 'rr://abc',
      reservation_id: 1,
      venue_name: 'Carbone',
      venue_url: carbone.url,
      date: '2026-04-24',
      time: '19:30',
      party_size: 2,
      type: 'Dining Room',
    });

    const result = await handleBookingTurn({
      chatId: 'chat-1',
      userMessage: 'yeah',
      history: [],
      intent: intent({ action: 'confirm', hasConfirmSignal: true }),
      resyAuthToken: 'tok',
    });

    expect(result.handled).toBe(true);
    expect(result.booked).toBe(true);
    expect(mockBookReservation).toHaveBeenCalledWith(expect.objectContaining({
      venueId: 555,
      day: '2026-04-24',
      partySize: 2,
      configToken: 'tok-730',
      bookedTime: '19:30',
      requestedTime: '19:30',
    }));
    expect(mockClearPending).toHaveBeenCalledWith('chat-1');
    expect(result.text).toContain('Carbone');
  });

  it('falls through to Claude when the guest confirms without any pending proposal', async () => {
    mockGetPending.mockResolvedValueOnce(null);

    const result = await handleBookingTurn({
      chatId: 'chat-1',
      userMessage: 'yeah',
      history: [],
      intent: intent({ action: 'confirm', hasConfirmSignal: true }),
      resyAuthToken: 'tok',
    });

    expect(result.handled).toBe(false);
    expect(mockBookReservation).not.toHaveBeenCalled();
  });
});
