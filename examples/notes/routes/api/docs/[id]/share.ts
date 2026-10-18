// Share a doc with everyone in a group: only the owner can do this.
import { defineHandler } from 'void';
import { requirePermission, writeTuples } from '@blbaker/openvoid/fga';
import { syncSignedInGroups } from '../_fga.ts';

export const POST = defineHandler(async (c) => {
  const id = c.req.param('id');
  const object = `doc:${id}`;
  await syncSignedInGroups();
  await requirePermission('owner', object);
  const { group } = await c.req.json<{ group?: string }>();
  if (!group || /[:#*\s]/.test(group)) {
    return c.json({ error: 'group is required and must not contain ":", "#", "*" or whitespace' }, 400);
  }
  // A userset tuple, not a user: group:<name>#member grants every current and future member of
  // that group the `viewer` relation, without writing one tuple per member.
  await writeTuples([{ user: `group:${group}#member`, relation: 'viewer', object }]);
  return { ok: true };
});
