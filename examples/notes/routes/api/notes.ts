import { notes } from '@schema';
import { defineHandler } from 'void';
import { db, desc } from 'void/db';

export const GET = defineHandler(async () => db.select().from(notes).orderBy(desc(notes.id)));

export const POST = defineHandler(async (c) => {
  const body = await c.req.json<{ title?: string }>();
  if (!body.title) return c.json({ error: 'title is required' }, 400);
  const [created] = await db.insert(notes).values({ title: body.title }).returning();
  return c.json(created, 201);
});
