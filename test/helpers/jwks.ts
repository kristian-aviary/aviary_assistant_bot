import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { PUBLIC, type CloudEnvironment } from '@microsoft/teams.api';
import { json, startFake, type FakeServer } from './httpFake.js';
import { CLIENT_ID } from './constants.js';

export const TEST_ISSUER = 'https://api.botframework.com';

export type TokenClaims = { aud?: string; iss?: string; serviceurl?: string; expiresInSeconds?: number; kid?: string };

export type FakeIdentityProvider = FakeServer & {
  cloud: CloudEnvironment;
  signToken(claims?: TokenClaims): Promise<string>;
  /** A token signed by a key that is not in the JWKS. */
  signWithUnknownKey(claims?: TokenClaims): Promise<string>;
};

/** A local stand-in for login.botframework.com: serves our test JWKS, so the SDK validates real signatures. */
export async function startFakeIdentityProvider(): Promise<FakeIdentityProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
  const server = await startFake((req, res) => {
    if (req.url === '/v1/.well-known/keys') return json(res, 200, { keys: [jwk] });
    return json(res, 404, {});
  });
  const cloud: CloudEnvironment = {
    ...PUBLIC,
    openIdMetadataUrl: `${server.url}/v1/.well-known/openidconfiguration`,
    tokenIssuer: TEST_ISSUER,
  };
  const sign = (key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'], kid: string) => async (c: TokenClaims = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({ serviceurl: c.serviceurl })
      .setProtectedHeader({ alg: 'RS256', kid: c.kid ?? kid })
      .setIssuer(c.iss ?? TEST_ISSUER)
      .setAudience(c.aud ?? CLIENT_ID)
      .setIssuedAt(now - 10)
      .setNotBefore(now - 10)
      .setExpirationTime(now + (c.expiresInSeconds ?? 600));
    return jwt.sign(key);
  };
  return Object.assign(server, {
    cloud,
    signToken: sign(privateKey, 'test-key-1'),
    signWithUnknownKey: sign(other.privateKey, 'test-key-1'),
  }) as FakeIdentityProvider;
}
