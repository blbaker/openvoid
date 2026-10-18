// Group sync: with OPENVOID_FGA_SYNC_GROUPS=1, make a signed-in user's `member` relation on
// group:<name> objects in OpenFGA match user.groups exactly (from the identity provider).
import type { AuthUser, Vars } from '../auth/types.ts';
import { fgaContext } from './client.ts';
import { encodeFgaId } from './ids.ts';
import { fgaUser } from './user.ts';

function groupObject(name: string): string {
  return `group:${encodeFgaId(name)}`;
}

async function currentGroupMemberships(client: Awaited<ReturnType<typeof fgaContext>>['client'], user: string): Promise<Set<string>> {
  const groups = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const page = await client.read({ user, relation: 'member', object: 'group:' }, { continuationToken, pageSize: 100 });
    for (const tuple of page.tuples) {
      if (tuple.key.object.startsWith('group:')) groups.add(tuple.key.object);
    }
    continuationToken = page.continuation_token || undefined;
  } while (continuationToken);
  return groups;
}

/** Called after every sign-in, e.g. to mirror the user's groups into OpenFGA. */
export async function onSignIn(user: AuthUser, vars: Vars): Promise<void> {
  if (vars.OPENVOID_FGA_SYNC_GROUPS !== '1') return;
  const { client } = await fgaContext(vars);
  const me = fgaUser(user);
  const desired = new Set(user.groups.map(groupObject));
  const current = await currentGroupMemberships(client, me);

  const toAdd = [...desired].filter((g) => !current.has(g));
  const toRemove = [...current].filter((g) => !desired.has(g));
  if (toAdd.length > 0) {
    await client.writeTuples(toAdd.map((object) => ({ user: me, relation: 'member', object })));
  }
  if (toRemove.length > 0) {
    await client.deleteTuples(toRemove.map((object) => ({ user: me, relation: 'member', object })));
  }
  if (toAdd.length > 0 || toRemove.length > 0) {
    console.log(`[openvoid] fga: synced ${user.id} group membership (+${toAdd.length} -${toRemove.length})`);
  }
}
