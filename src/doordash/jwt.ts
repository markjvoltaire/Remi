import jwt, { type SignOptions } from 'jsonwebtoken';

export interface DoorDashAccessKeyParts {
  developerId: string;
  keyId: string;
  signingSecretBase64: string;
}

/**
 * Decode DoorDash portal signing secret. DoorDash documents base64url; standard
 * base64 from env still works after normalization + padding.
 */
export function decodeDoorDashSigningSecret(signingSecretBase64: string): Buffer {
  const s = signingSecretBase64.trim();
  if (!s) throw new Error('DOORDASH_SIGNING_SECRET is empty');
  const standard = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = standard.length % 4;
  const padded = pad ? standard + '='.repeat(4 - pad) : standard;
  return Buffer.from(padded, 'base64');
}

/**
 * Mint a short-lived JWT for DoorDash OpenAPI (Drive).
 * Never log the returned token.
 */
export function mintDoorDashJwt(parts: DoorDashAccessKeyParts, ttlSeconds = 300): string {
  const now = Math.floor(Date.now() / 1000);
  const secret = decodeDoorDashSigningSecret(parts.signingSecretBase64);

  const payload = {
    aud: 'doordash',
    iss: parts.developerId,
    kid: parts.keyId,
    exp: now + ttlSeconds,
    iat: now,
  };

  const options: SignOptions = {
    algorithm: 'HS256',
    header: { 'dd-ver': 'DD-JWT-V1' } as unknown as SignOptions['header'],
  };
  return jwt.sign(payload, secret, options);
}
