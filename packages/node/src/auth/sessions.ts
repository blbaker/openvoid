// Server-side sessions kept in OpenVoid's KV binding, so they work on every KV backend
// (SQLite, Redis, DynamoDB) and survive restarts. The cookie holds a random id; KV stores the
// session under a SHA-256 of that id, so reading the store never yields a usable cookie.
import { createHash, randomBytes } from 'node:crypto';
import type { AuthSession, AuthUser, Vars } from './types.ts';

type KV = {
  get(key: string, type?: 'text'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export type CookieOptions = { name: string; secure: boolean | 'auto'; maxAge: number };

export class SessionStore {
  readonly #kv: KV;
  readonly cookie: CookieOptions;

  constructor(kv: KV, vars: Vars) {
    this.#kv = kv;
    const days = Number(vars.OPENVOID_AUTH_SESSION_DAYS ?? 30);
    this.cookie = {
      name: vars.OPENVOID_AUTH_COOKIE ?? 'openvoid_session',
      secure: vars.OPENVOID_AUTH_SECURE_COOKIES === '0' ? false : vars.OPENVOID_AUTH_SECURE_COOKIES === '1' ? true : 'auto',
      maxAge: Math.round(days * 86400),
    };
  }

  #key(id: string): string {
    return `openvoid:session:${createHash('sha256').update(id).digest('base64url')}`;
  }

  async create(user: AuthUser, extra: Record<string, unknown> = {}): Promise<AuthSession> {
    const id = randomBytes(32).toString('base64url');
    const now = Date.now();
    const session: AuthSession = { id, user, createdAt: now, expiresAt: now + this.cookie.maxAge * 1000 };
    await this.#kv.put(this.#key(id), JSON.stringify({ ...session, id: undefined, extra }), {
      expirationTtl: this.cookie.maxAge,
    });
    return session;
  }

  async get(id: string): Promise<(AuthSession & { extra: Record<string, unknown> }) | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const raw = await this.#kv.get(this.#key(id), 'text');
    if (typeof raw !== 'string') return null;
    const stored = JSON.parse(raw) as Omit<AuthSession, 'id'> & { extra?: Record<string, unknown> };
    if (stored.expiresAt <= Date.now()) return null;
    return { ...stored, id, extra: stored.extra ?? {} };
  }

  async delete(id: string): Promise<void> {
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) await this.#kv.delete(this.#key(id));
  }

  /** The session id from the request's cookie header, if any. */
  idFrom(request: Request): string | null {
    return readCookie(request, this.cookie.name);
  }

  setCookie(request: Request, session: AuthSession): string {
    return serializeCookie(this.cookie.name, session.id, {
      maxAge: this.cookie.maxAge,
      secure: this.cookie.secure === 'auto' ? isHttps(request) : this.cookie.secure,
    });
  }

  clearCookie(request: Request): string {
    return serializeCookie(this.cookie.name, '', {
      maxAge: 0,
      secure: this.cookie.secure === 'auto' ? isHttps(request) : this.cookie.secure,
    });
  }
}

export function isHttps(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]!.trim() === 'https';
  return new URL(request.url).protocol === 'https:';
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean; path?: string; sameSite?: 'Lax' | 'Strict' | 'None' },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Only same-site relative paths are allowed as a post-sign-in destination, so a crafted
 * ?returnTo= can't bounce users to another site.
 */
export function safeReturnTo(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}
