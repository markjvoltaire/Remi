/**
 * Config for the cloud-browser payment handoff. Feature-flagged off by default so
 * Phase 1 behavior (paymentFrontDesk SMS) remains the live path until the operator
 * flips CLOUD_BROWSER_ENABLED=true AND provides Browserbase credentials.
 */
export const cloudBrowserConfig = {
  enabled: (process.env.CLOUD_BROWSER_ENABLED ?? '').toLowerCase() === 'true',
  apiKey: process.env.BROWSERBASE_API_KEY ?? '',
  projectId: process.env.BROWSERBASE_PROJECT_ID ?? '',
  sessionTimeoutMs: Number(process.env.CLOUD_BROWSER_SESSION_TIMEOUT_MS ?? 900_000),
};

/**
 * True when the flag is on AND both Browserbase credentials are present.
 * Read at call-time (not at module load) so tests can stub env vars.
 */
export function isCloudBrowserReady(): boolean {
  const flag = (process.env.CLOUD_BROWSER_ENABLED ?? '').toLowerCase() === 'true';
  const apiKey = process.env.BROWSERBASE_API_KEY ?? '';
  const projectId = process.env.BROWSERBASE_PROJECT_ID ?? '';
  return flag && apiKey.length > 0 && projectId.length > 0;
}

export function getSessionTimeoutMs(): number {
  const v = Number(process.env.CLOUD_BROWSER_SESSION_TIMEOUT_MS ?? 900_000);
  return Number.isFinite(v) && v > 0 ? v : 900_000;
}

export function getBrowserbaseCreds(): { apiKey: string; projectId: string } {
  return {
    apiKey: process.env.BROWSERBASE_API_KEY ?? '',
    projectId: process.env.BROWSERBASE_PROJECT_ID ?? '',
  };
}
