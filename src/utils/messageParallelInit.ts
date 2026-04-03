import type { ChatInfo } from '../blooio/client.js';
import type { UserProfile } from '../state/conversation.js';

export interface MessageParallelInitFns {
  markAsRead: (chatId: string) => Promise<void>;
  startTyping: (chatId: string) => Promise<void>;
  getChat: (chatId: string) => Promise<ChatInfo>;
  getUserProfile: (handle: string) => Promise<UserProfile | null>;
  shareContactCard: (chatId: string) => Promise<void>;
}

/**
 * Runs Blooio + profile prefetch in parallel. markAsRead / startTyping / shareContactCard
 * failures are logged and do not abort — new users still get onboarding replies.
 */
export async function runMessageParallelInit(
  chatId: string,
  from: string,
  shouldShareContact: boolean,
  fns: MessageParallelInitFns,
  logPrefix: string,
): Promise<{ chatInfo: ChatInfo; senderProfile: UserProfile | null }> {
  const tasks: Promise<unknown>[] = [
    fns.markAsRead(chatId),
    fns.startTyping(chatId),
    fns.getChat(chatId),
    fns.getUserProfile(from),
  ];
  if (shouldShareContact) tasks.push(fns.shareContactCard(chatId));

  const labels = shouldShareContact
    ? (['markAsRead', 'startTyping', 'getChat', 'getUserProfile', 'shareContactCard'] as const)
    : (['markAsRead', 'startTyping', 'getChat', 'getUserProfile'] as const);

  const results = await Promise.allSettled(tasks);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      const name = labels[i] ?? `task_${i}`;
      if (name === 'markAsRead' || name === 'startTyping' || name === 'shareContactCard') {
        console.warn(`${logPrefix} ${name} failed (non-fatal):`, r.reason);
      }
    }
  }

  const chatR = results[2] as PromiseSettledResult<ChatInfo>;
  if (chatR.status === 'rejected') {
    console.error(`${logPrefix} getChat failed:`, chatR.reason);
    throw chatR.reason;
  }

  const profR = results[3] as PromiseSettledResult<UserProfile | null>;
  let senderProfile: UserProfile | null = null;
  if (profR.status === 'fulfilled') {
    senderProfile = profR.value;
  } else {
    console.warn(`${logPrefix} getUserProfile failed (continuing without profile):`, profR.reason);
  }

  return { chatInfo: chatR.value, senderProfile };
}
