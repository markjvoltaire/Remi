import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runMessageParallelInit } from '../../utils/messageParallelInit.js';
import type { ChatInfo } from '../../blooio/client.js';
import type { UserProfile } from '../../state/conversation.js';

const chatInfo: ChatInfo = {
  id: 'chat-1',
  display_name: null,
  handles: [{ handle: 'chat-1', service: 'iMessage' }],
  is_group: false,
  service: 'iMessage',
};

const profile: UserProfile = {
  handle: '+15550001',
  name: 'Test',
  facts: [],
  firstSeen: 1,
  lastSeen: 2,
};

describe('runMessageParallelInit', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns chatInfo and senderProfile when markAsRead rejects', async () => {
    const markAsRead = vi.fn().mockRejectedValue(new Error('read API 404'));
    const startTyping = vi.fn().mockResolvedValue(undefined);
    const getChat = vi.fn().mockResolvedValue(chatInfo);
    const getUserProfile = vi.fn().mockResolvedValue(profile);
    const shareContactCard = vi.fn().mockResolvedValue(undefined);

    const out = await runMessageParallelInit(
      'chat-1',
      '+15550001',
      false,
      { markAsRead, startTyping, getChat, getUserProfile, shareContactCard },
      '[test]',
    );

    expect(out.chatInfo).toEqual(chatInfo);
    expect(out.senderProfile).toEqual(profile);
    expect(markAsRead).toHaveBeenCalledWith('chat-1');
    expect(console.warn).toHaveBeenCalled();
  });

  it('returns null profile when getUserProfile rejects', async () => {
    const markAsRead = vi.fn().mockResolvedValue(undefined);
    const startTyping = vi.fn().mockResolvedValue(undefined);
    const getChat = vi.fn().mockResolvedValue(chatInfo);
    const getUserProfile = vi.fn().mockRejectedValue(new Error('db down'));
    const shareContactCard = vi.fn().mockResolvedValue(undefined);

    const out = await runMessageParallelInit(
      'chat-1',
      '+15550001',
      false,
      { markAsRead, startTyping, getChat, getUserProfile, shareContactCard },
      '[test]',
    );

    expect(out.chatInfo).toEqual(chatInfo);
    expect(out.senderProfile).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('throws when getChat rejects', async () => {
    const markAsRead = vi.fn().mockResolvedValue(undefined);
    const startTyping = vi.fn().mockResolvedValue(undefined);
    const getChat = vi.fn().mockRejectedValue(new Error('no chat'));
    const getUserProfile = vi.fn().mockResolvedValue(null);
    const shareContactCard = vi.fn().mockResolvedValue(undefined);

    await expect(
      runMessageParallelInit('chat-1', '+15550001', false, {
        markAsRead,
        startTyping,
        getChat,
        getUserProfile,
        shareContactCard,
      }, '[test]'),
    ).rejects.toThrow('no chat');

    expect(console.error).toHaveBeenCalled();
  });

  it('logs non-fatal when shareContactCard rejects', async () => {
    const markAsRead = vi.fn().mockResolvedValue(undefined);
    const startTyping = vi.fn().mockResolvedValue(undefined);
    const getChat = vi.fn().mockResolvedValue(chatInfo);
    const getUserProfile = vi.fn().mockResolvedValue(null);
    const shareContactCard = vi.fn().mockRejectedValue(new Error('share failed'));

    const out = await runMessageParallelInit(
      'chat-1',
      '+15550001',
      true,
      { markAsRead, startTyping, getChat, getUserProfile, shareContactCard },
      '[test]',
    );

    expect(out.chatInfo).toEqual(chatInfo);
    expect(console.warn).toHaveBeenCalled();
  });
});
