// The runtime API apps import as `@blbaker/openvoid/fga`: check, requirePermission, listObjects,
// grant/revoke and the writeTuples/deleteTuples passthrough.
//
// Configuration is read from process.env, the same object migrateFga/onSignIn are handed as
// `vars` by server.ts and plugin.ts in production and in scripts/e2e.sh. In dev (vite) this means
// OPENVOID_FGA_* must be real environment variables, not only entries in an app .env file: unlike
// void/kv or void/storage, there is no per-request binding this module can read instead, and
// adding one would mean editing plugin.ts/server.ts, outside this module's file ownership.
import { AuthHttpError, getUser } from '../auth/context.ts';
import type { AuthUser } from '../auth/types.ts';
import { fgaContext } from './client.ts';
import { fgaUser } from './user.ts';

export type FgaTuple = { user: string; relation: string; object: string };
export type FgaCheckOptions = { user?: string | AuthUser; contextualTuples?: FgaTuple[] };
export type FgaGrantOptions = { user?: string | AuthUser };

const vars = () => process.env;

/** The user a call acts as: an explicit opts.user, or the signed-in user. Null means anonymous. */
function actingUser(opts?: { user?: string | AuthUser }): string | null {
  if (opts?.user !== undefined) return fgaUser(opts.user);
  const signedIn = getUser();
  return signedIn ? fgaUser(signedIn) : null;
}

function requireActingUser(opts?: { user?: string | AuthUser }): string {
  const user = actingUser(opts);
  if (!user) throw new Error('openvoid: fga needs a signed-in user or an explicit `user` option.');
  return user;
}

/** Does `relation` hold of `object` for a user? Anonymous (no session, no opts.user) is always false. */
export async function check(relation: string, object: string, opts: FgaCheckOptions = {}): Promise<boolean> {
  const user = actingUser(opts);
  if (!user) return false;
  const { client } = await fgaContext(vars());
  const { allowed } = await client.check({ user, relation, object, contextualTuples: opts.contextualTuples });
  return allowed ?? false;
}

/** check(), turned into the error Void's router responds with: 401 anonymous, 403 denied. */
export async function requirePermission(relation: string, object: string): Promise<void> {
  const user = getUser();
  if (!user) throw new AuthHttpError(401, 'Unauthorized');
  const allowed = await check(relation, object, { user });
  if (!allowed) throw new AuthHttpError(403, 'Forbidden');
}

/** Every object of `type` the user has `relation` to. Anonymous: always []. */
export async function listObjects(type: string, relation: string, opts: FgaCheckOptions = {}): Promise<string[]> {
  const user = actingUser(opts);
  if (!user) return [];
  const { client } = await fgaContext(vars());
  const { objects } = await client.listObjects({ type, relation, user, contextualTuples: opts.contextualTuples });
  return objects;
}

/** Give `relation` on `object` to the signed-in user, or opts.user. */
export async function grant(relation: string, object: string, opts: FgaGrantOptions = {}): Promise<void> {
  const user = requireActingUser(opts);
  await writeTuples([{ user, relation, object }]);
}

/** Take `relation` on `object` away from the signed-in user, or opts.user. */
export async function revoke(relation: string, object: string, opts: FgaGrantOptions = {}): Promise<void> {
  const user = requireActingUser(opts);
  await deleteTuples([{ user, relation, object }]);
}

/** Passthrough to the OpenFGA client's write. Tuples are already `{user, relation, object}`;
 * use fgaUser() for a `user:` tuple or a raw string like "group:family#member" for a userset. */
export async function writeTuples(tuples: FgaTuple[]): Promise<void> {
  if (tuples.length === 0) return;
  const { client } = await fgaContext(vars());
  await client.writeTuples(tuples);
}

/** Passthrough to the OpenFGA client's delete. */
export async function deleteTuples(tuples: FgaTuple[]): Promise<void> {
  if (tuples.length === 0) return;
  const { client } = await fgaContext(vars());
  await client.deleteTuples(tuples);
}
