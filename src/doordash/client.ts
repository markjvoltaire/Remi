import { EMBEDDED_DOORDASH } from './embeddedCredentials.js';
import { mintDoorDashJwt, type DoorDashAccessKeyParts } from './jwt.js';
import type { DoorDashCreateDeliveryRequest, DoorDashDeliverySummary } from './types.js';

const DEFAULT_BASE = 'https://openapi.doordash.com';

/** Returns embedded sandbox keys when non-null. Set to null in embeddedCredentials.ts before production. */
function embeddedCredentials(): DoorDashAccessKeyParts | null {
  return EMBEDDED_DOORDASH;
}

export class DoorDashApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(message);
    this.name = 'DoorDashApiError';
  }
}

function getBaseUrl(): string {
  if (embeddedCredentials() !== null) return DEFAULT_BASE;
  const b = process.env.DOORDASH_API_BASE?.trim();
  return b && b.length > 0 ? b.replace(/\/$/, '') : DEFAULT_BASE;
}

function loadAccessKeyFromEnv(): DoorDashAccessKeyParts | null {
  const developerId = process.env.DOORDASH_DEVELOPER_ID?.trim();
  const keyId = process.env.DOORDASH_KEY_ID?.trim();
  const signingSecretBase64 = process.env.DOORDASH_SIGNING_SECRET?.trim();
  if (!developerId || !keyId || !signingSecretBase64) return null;
  return { developerId, keyId, signingSecretBase64 };
}

/**
 * Development: embedded credentials first (ignore DOORDASH_* in .env) for fast local/sandbox tests.
 * Production: env only.
 */
function loadAccessKey(): DoorDashAccessKeyParts | null {
  const embedded = embeddedCredentials();
  if (embedded !== null) return embedded;
  return loadAccessKeyFromEnv();
}

function isDoorDashEnvEnabled(): boolean {
  const raw = process.env.DOORDASH_ENABLED ?? process.env.DOORDASH_ENABLE;
  const trimmed = raw !== undefined && raw !== null ? String(raw).trim() : '';
  if (trimmed !== '') {
    const v = trimmed.toLowerCase();
    if (v === 'false' || v === '0' || v === 'no') return false;
    if (v === 'true' || v === '1' || v === 'yes') return true;
    return false;
  }
  if (embeddedCredentials() !== null) return true;
  return false;
}

export function isDoorDashConfigured(): boolean {
  if (!isDoorDashEnvEnabled()) return false;
  return loadAccessKey() !== null;
}

async function doorDashFetch(path: string, init: RequestInit): Promise<Response> {
  const key = loadAccessKey();
  if (!key) {
    throw new Error('DoorDash credentials are not configured');
  }
  const token = mintDoorDashJwt(key);
  const url = `${getBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers as Record<string, string>),
    },
    signal: AbortSignal.timeout(15_000),
  });

  return res;
}

export async function createDelivery(body: DoorDashCreateDeliveryRequest): Promise<DoorDashDeliverySummary> {
  console.log(`[doordash] Creating delivery ${body.external_delivery_id}`);

  const res = await doorDashFetch('/drive/v2/deliveries', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    const snippet = text.length > 800 ? `${text.slice(0, 800)}…` : text;
    throw new DoorDashApiError(`DoorDash API ${res.status}: ${snippet}`, res.status, text);
  }

  try {
    return JSON.parse(text) as DoorDashDeliverySummary;
  } catch {
    throw new DoorDashApiError('DoorDash returned non-JSON success body', res.status, text);
  }
}

export async function getDelivery(externalDeliveryId: string): Promise<DoorDashDeliverySummary> {
  const encoded = encodeURIComponent(externalDeliveryId);
  const res = await doorDashFetch(`/drive/v2/deliveries/${encoded}`, { method: 'GET' });

  const text = await res.text();
  if (!res.ok) {
    const snippet = text.length > 800 ? `${text.slice(0, 800)}…` : text;
    throw new DoorDashApiError(`DoorDash API ${res.status}: ${snippet}`, res.status, text);
  }

  try {
    return JSON.parse(text) as DoorDashDeliverySummary;
  } catch {
    throw new DoorDashApiError('DoorDash returned non-JSON success body', res.status, text);
  }
}
