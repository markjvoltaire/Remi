import Browserbase from '@browserbasehq/sdk';
import { getBrowserbaseCreds, getSessionTimeoutMs } from './config.js';

let cachedClient: Browserbase | null = null;

function getClient(): Browserbase {
  if (cachedClient) return cachedClient;
  const { apiKey } = getBrowserbaseCreds();
  if (!apiKey) {
    throw new Error('[cloudBrowser] BROWSERBASE_API_KEY missing — cannot create session');
  }
  cachedClient = new Browserbase({ apiKey });
  return cachedClient;
}

/**
 * Reset the memoized Browserbase client. Test-only escape hatch so that
 * vi.stubEnv changes to BROWSERBASE_API_KEY take effect between cases.
 */
export function __resetBrowserbaseClientForTests(): void {
  cachedClient = null;
}

export interface CloudBrowserSession {
  id: string;
  connectUrl: string;
  liveViewUrl: string;
  expiresAt: Date;
}

/**
 * Create a Browserbase session with residential proxy enabled and return both the
 * CDP connect URL and the live-view (debugger) URL we hand to the user.
 */
export async function createSession(opts: { timeoutMs?: number } = {}): Promise<CloudBrowserSession> {
  const { projectId } = getBrowserbaseCreds();
  const client = getClient();

  const timeoutMs = opts.timeoutMs ?? getSessionTimeoutMs();
  const timeoutSeconds = Math.max(60, Math.floor(timeoutMs / 1000));

  const created = await client.sessions.create({
    projectId,
    proxies: true,
    timeout: timeoutSeconds,
  });

  const live = await client.sessions.debug(created.id);

  return {
    id: created.id,
    connectUrl: created.connectUrl,
    liveViewUrl: live.debuggerFullscreenUrl,
    expiresAt: new Date(created.expiresAt),
  };
}

/**
 * Best-effort session close. Browserbase idempotently ignores closed sessions.
 */
export async function closeSession(id: string): Promise<void> {
  try {
    const client = getClient();
    await client.sessions.update(id, {
      projectId: getBrowserbaseCreds().projectId,
      status: 'REQUEST_RELEASE',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cloudBrowser] closeSession failed for ${id}: ${msg}`);
  }
}
