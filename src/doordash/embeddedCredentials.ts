import type { DoorDashAccessKeyParts } from './jwt.js';

/**
 * Sandbox Drive keys for local dev only (`NODE_ENV === "development"`).
 * While embedded is non-null, credentials and API base ignore DOORDASH_* env
 * (so Render/.env copies do not override). Production uses env only.
 * Set to null to opt out; use DOORDASH_ENABLED=false to disable the tool in dev.
 */
export const EMBEDDED_DOORDASH: DoorDashAccessKeyParts | null = {
  developerId: 'f4a29465-3b9f-4ac1-ab38-197bbda51170',
  keyId: '64c19d66-c9de-46b4-9a01-8c78b01f85b5',
  signingSecretBase64: 'V-PGGOanQdR7BaAH9Cz7w7ne8qv7zwHz7MIjTKuk2Z8',
};
