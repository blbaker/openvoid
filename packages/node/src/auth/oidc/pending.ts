// A sign-in in progress (PKCE verifier, nonce, which provider, where to return to) is server
// state, not something the browser can be trusted with. It lives in KV under a hash of `state`
// (same pattern as sessions.ts), expires in 10 minutes, and is deleted the moment the callback
// reads it, so a replayed callback request finds nothing. A short-lived HttpOnly cookie carries
// `state` back from the login redirect to the callback, binding the pending entry to this browser:
// the callback must see the same `state` in both the cookie and the query string.
import { createHash, randomBytes } from 'node:crypto';
import { isHttps, readCookie, serializeCookie } from '../sessions.ts';

type KV = {
  get(key: string, type?: 'text'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export type PendingSignIn = {
  provider: string;
  returnTo: string;
  /** OIDC only. */
  codeVerifier?: string;
  nonce?: string;
};

const TTL_SECONDS = 600;
const TXN_COOKIE = 'openvoid_auth_txn';

function key(state: string): string {
  return `openvoid:oidcpending:${createHash('sha256').update(state).digest('base64url')}`;
}

export function randomState(): string {
  return randomBytes(32).toString('base64url');
}

export async function createPending(kv: KV, state: string, data: PendingSignIn): Promise<void> {
  await kv.put(key(state), JSON.stringify(data), { expirationTtl: TTL_SECONDS });
}

/** Single use: always deletes, whether or not a valid entry was found. */
export async function consumePending(kv: KV, state: string): Promise<PendingSignIn | null> {
  const raw = await kv.get(key(state), 'text');
  await kv.delete(key(state));
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as PendingSignIn;
  } catch {
    return null;
  }
}

export function setTxnCookie(request: Request, basePath: string, state: string): string {
  return serializeCookie(TXN_COOKIE, state, { maxAge: TTL_SECONDS, secure: isHttps(request), path: basePath, sameSite: 'Lax' });
}

export function clearTxnCookie(request: Request, basePath: string): string {
  return serializeCookie(TXN_COOKIE, '', { maxAge: 0, secure: isHttps(request), path: basePath, sameSite: 'Lax' });
}

export function readTxnCookie(request: Request): string | null {
  return readCookie(request, TXN_COOKIE);
}
