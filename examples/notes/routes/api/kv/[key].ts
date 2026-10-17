import { defineHandler } from 'void';
import { kv } from 'void/kv';

export const GET = defineHandler(async (c) => {
  const value = await kv.get(c.req.param('key'));
  return value === null ? c.json({ error: 'not found' }, 404) : { value };
});

export const PUT = defineHandler(async (c) => {
  const { value, ttl } = await c.req.json<{ value: unknown; ttl?: number }>();
  await kv.put(c.req.param('key'), value, ttl ? { ttl } : undefined);
  return { ok: true };
});
