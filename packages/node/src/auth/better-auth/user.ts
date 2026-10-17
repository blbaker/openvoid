// Maps Better Auth's user + account rows onto OpenVoid's AuthUser.
//
// id scheme: a user who has never linked a social/OIDC account is "local:<better-auth user
// id>" (the id Better Auth itself assigned on sign-up). A user with one or more linked
// provider accounts (Google, GitHub, or an OIDC provider through genericOAuth) is
// "<providerId>:<accountId>" using their oldest linked account, so the id survives the local
// user row changing (name, email) and stays the same if they later also set a password.
// Email+password accounts are stored by Better Auth with providerId "credential" and are not
// picked here.
import type { AuthUser } from '../types.ts';

export type UserRow = {
  id: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image?: string | null;
  groups?: string | null;
};

export type AccountRow = {
  providerId: string;
  accountId: string;
  createdAt: string | Date;
};

type Where = { field: string; value: unknown; operator?: string };
export type AdapterLike = {
  findMany<T>(data: { model: string; where?: Where[]; sortBy?: { field: string; direction: 'asc' | 'desc' } }): Promise<T[]>;
};

export function parseGroups(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

/** The oldest non-credential account, or null when the user only has email+password. */
export function primaryAccount(accounts: AccountRow[]): AccountRow | null {
  const external = accounts.filter((a) => a.providerId !== 'credential');
  if (external.length === 0) return null;
  return external.slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0] ?? null;
}

export function toAuthUser(user: UserRow, account: AccountRow | null): AuthUser {
  const provider = account?.providerId ?? 'local';
  const subject = account?.accountId ?? user.id;
  return {
    id: `${provider}:${subject}`,
    provider,
    subject,
    email: user.email ?? null,
    emailVerified: Boolean(user.emailVerified),
    name: user.name ?? null,
    image: user.image ?? null,
    groups: parseGroups(user.groups),
  };
}

/** Loads the linked accounts and builds the AuthUser for an already-fetched user row. */
export async function loadAuthUser(adapter: AdapterLike, user: UserRow): Promise<AuthUser> {
  const accounts = await adapter.findMany<AccountRow>({
    model: 'account',
    where: [{ field: 'userId', value: user.id }],
    sortBy: { field: 'createdAt', direction: 'asc' },
  });
  return toAuthUser(user, primaryAccount(accounts));
}

/** Normalizes an OIDC groups claim (array, comma-separated string, or absent) to string[]. */
export function normalizeGroupsClaim(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return [];
}
