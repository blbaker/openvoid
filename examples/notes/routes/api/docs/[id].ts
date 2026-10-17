// Docs stored in void/kv, protected by OpenFGA (see fga/model.fga and recipes/authz-openfga).
// The first write to a doc id creates it and makes the writer its owner; later writes need
// `editor` (granted to the owner automatically, since the model's editor relation includes
// owner); reading needs `viewer` (granted to editor, and to anyone a doc is shared with, see
// routes/api/docs/[id]/share.ts).
import { defineHandler } from 'void';
import { kv } from 'void/kv';
import { requireAuth } from '@openvoid/node/auth';
import { grant, requirePermission } from '@openvoid/node/fga';
import { syncSignedInGroups } from './_fga.ts';

type Doc = { id: string; body: string; updatedAt: number };

const keyFor = (id: string) => `doc:${id}`;

export const GET = defineHandler(async (c) => {
  const id = c.req.param('id');
  await syncSignedInGroups();
  await requirePermission('viewer', `doc:${id}`);
  const doc = await kv.get<Doc>(keyFor(id));
  return doc === null ? c.json({ error: 'not found' }, 404) : doc;
});

export const PUT = defineHandler(async (c) => {
  const id = c.req.param('id');
  const object = `doc:${id}`;
  await syncSignedInGroups();
  const existing = await kv.get<Doc>(keyFor(id));
  if (existing === null) {
    requireAuth(); // creating is open to anyone signed in; they become the owner below
  } else {
    await requirePermission('editor', object);
  }
  const { body } = await c.req.json<{ body?: string }>();
  const doc: Doc = { id, body: body ?? '', updatedAt: Date.now() };
  await kv.put(keyFor(id), doc);
  if (existing === null) await grant('owner', object);
  return doc;
});
