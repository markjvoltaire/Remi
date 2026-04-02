import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { decodeDoorDashSigningSecret, mintDoorDashJwt } from '../../doordash/jwt.js';

describe('decodeDoorDashSigningSecret', () => {
  it('decodes standard base64', () => {
    const raw = Buffer.from('x'.repeat(32));
    const b64 = raw.toString('base64');
    expect(decodeDoorDashSigningSecret(b64).equals(raw)).toBe(true);
  });

  it('decodes base64url (no padding)', () => {
    const raw = Buffer.alloc(32, 0xab);
    const b64url = raw
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(decodeDoorDashSigningSecret(b64url).equals(raw)).toBe(true);
  });

  it('trims whitespace', () => {
    const raw = Buffer.from('secret');
    const b64 = raw.toString('base64');
    expect(decodeDoorDashSigningSecret(`  ${b64}  `).equals(raw)).toBe(true);
  });
});

describe('mintDoorDashJwt', () => {
  it('verifies when secret is base64url from portal shape', () => {
    const key = Buffer.alloc(32, 7);
    const signingSecretBase64 = key
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const token = mintDoorDashJwt(
      { developerId: 'dev1', keyId: 'kid1', signingSecretBase64 },
      120,
    );
    const decoded = jwt.verify(token, key, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    expect(decoded.aud).toBe('doordash');
    expect(decoded.iss).toBe('dev1');
    expect(decoded.kid).toBe('kid1');
  });
});
