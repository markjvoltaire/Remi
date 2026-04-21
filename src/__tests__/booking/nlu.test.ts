import { describe, it, expect, vi } from 'vitest';

// Mock Anthropic so extractBookingIntent doesn't hit the network.
const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: (...args: unknown[]) => mockMessagesCreate(...args) };
    },
  };
});

import {
  parseConfirmSignal,
  parseRejectSignal,
  parseTimeToHHMM,
  parsePartySize,
  parseDate,
  extractBookingIntent,
} from '../../booking/nlu.js';

describe('parseConfirmSignal', () => {
  it('matches simple yes/ok variants', () => {
    for (const m of ['yes', 'Yeah', 'yep', 'ok', 'okay', 'sure', 'book it', 'lock it in', 'do it']) {
      expect(parseConfirmSignal(m)).toBe(true);
    }
  });
  it('rejects partial confirmations that also carry new info', () => {
    expect(parseConfirmSignal('yes but at 8pm')).toBe(false);
    expect(parseConfirmSignal('yes at Carbone instead')).toBe(false);
  });
});

describe('parseRejectSignal', () => {
  it('matches nevermind and cancel variants', () => {
    expect(parseRejectSignal('nevermind')).toBe(true);
    expect(parseRejectSignal('cancel')).toBe(true);
    expect(parseRejectSignal('nope.')).toBe(true);
  });
});

describe('parseTimeToHHMM', () => {
  it('handles 12h and 24h formats', () => {
    expect(parseTimeToHHMM('7:30pm')).toBe('19:30');
    expect(parseTimeToHHMM('7 pm')).toBe('19:00');
    expect(parseTimeToHHMM('12am')).toBe('00:00');
    expect(parseTimeToHHMM('12pm')).toBe('12:00');
    expect(parseTimeToHHMM('18:30')).toBe('18:30');
  });
  it('returns null when no time found', () => {
    expect(parseTimeToHHMM('book a table')).toBeNull();
  });
});

describe('parsePartySize', () => {
  it('extracts party of N, for N, N people', () => {
    expect(parsePartySize('party of 4')).toBe(4);
    expect(parsePartySize('table for 2')).toBe(2);
    expect(parsePartySize('3 people')).toBe(3);
    expect(parsePartySize('2 guests')).toBe(2);
  });
  it('handles spelled-out numbers', () => {
    expect(parsePartySize('for two')).toBe(2);
    expect(parsePartySize('for a couple')).toBe(2);
  });
});

describe('parseDate', () => {
  const ref = new Date('2026-04-21T12:00:00'); // Tuesday Apr 21, 2026

  it('resolves relative terms', () => {
    expect(parseDate('today', ref)).toBe('2026-04-21');
    expect(parseDate('tonight', ref)).toBe('2026-04-21');
    expect(parseDate('tomorrow', ref)).toBe('2026-04-22');
  });

  it('resolves weekday names to the next occurrence', () => {
    // Friday after Tuesday 4/21 is 4/24
    expect(parseDate('Friday', ref)).toBe('2026-04-24');
    expect(parseDate('this Friday', ref)).toBe('2026-04-24');
    // "next Friday" is a week later
    expect(parseDate('next Friday', ref)).toBe('2026-05-01');
  });

  it('parses ISO and month names', () => {
    expect(parseDate('2026-04-25', ref)).toBe('2026-04-25');
    expect(parseDate('April 25', ref)).toBe('2026-04-25');
    expect(parseDate('Apr 25', ref)).toBe('2026-04-25');
    expect(parseDate('4/25', ref)).toBe('2026-04-25');
  });
});

describe('extractBookingIntent', () => {
  it('returns confirm without calling the LLM when the message is a bare yes', async () => {
    mockMessagesCreate.mockClear();
    const intent = await extractBookingIntent('yeah', []);
    expect(intent.action).toBe('confirm');
    expect(intent.hasConfirmSignal).toBe(true);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('uses the LLM to extract restaurant and action on a full booking request', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'extract_booking_intent',
          input: { action: 'book', restaurant: 'Carbone', city: 'New York' },
        },
      ],
    });
    const ref = new Date('2026-04-21T12:00:00');
    const intent = await extractBookingIntent(
      'Carbone Friday 7:30pm for 2',
      [],
      ref,
    );
    expect(intent.action).toBe('book');
    expect(intent.restaurant).toBe('Carbone');
    expect(intent.city).toBe('New York');
    expect(intent.date).toBe('2026-04-24');
    expect(intent.time).toBe('19:30');
    expect(intent.partySize).toBe(2);
  });
});
