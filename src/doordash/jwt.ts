import jwt, { type SignOptions } from 'jsonwebtoken';

export interface DoorDashAccessKeyParts {
  developerId: string;
  keyId: string;
  signingSecretBase64: string;
}

/**
 * Mint a short-lived JWT for DoorDash OpenAPI (Drive).
 * Never log the returned token.
 */
export function mintDoorDashJwt(parts: DoorDashAccessKeyParts, ttlSeconds = 300): string {
  const now = Math.floor(Date.now() / 1000);
  const secret = Buffer.from(parts.signingSecretBase64, 'base64');

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
