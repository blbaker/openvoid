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

let warnedBadGroups = false;

/**
 * Only this module writes the column, so a value that isn't a JSON array means a hand-edited
 * row. No groups is the safe reading (it can only take access away); warn once rather than
 * failing every request that user makes.
 */
function badGroups(detail: unknown): string[] {
  if (!warnedBadGroups) {
    warnedBadGroups = true;
    console.warn('[openvoid] a user.groups value is not a JSON array of strings; treating it as no groups:', detail);
  }
  return [];
}

function parseGroups(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return badGroups(error);
  }
  return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : badGroups(parsed);
}

function toAuthUser(user: UserRow, account: AccountRow | undefined): AuthUser {
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

export async function loadAuthUser(adapter: AdapterLike, user: UserRow): Promise<AuthUser> {
  const accounts = await adapter.findMany<AccountRow>({
    model: 'account',
    where: [{ field: 'userId', value: user.id }],
    sortBy: { field: 'createdAt', direction: 'asc' },
  });
  // Oldest first, so this picks the first provider the user ever linked.
  return toAuthUser(user, accounts.find((a) => a.providerId !== 'credential'));
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
