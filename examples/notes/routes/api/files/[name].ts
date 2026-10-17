import { defineHandler } from 'void';
import { storage } from 'void/storage';

export const GET = defineHandler(async (c) => {
  const object = await storage.get(c.req.param('name'));
  if (!object) return c.json({ error: 'not found' }, 404);
  const headers = new Headers({ etag: object.httpEtag });
  object.writeHttpMetadata(headers);
  return new Response(object.body, { headers });
});

export const PUT = defineHandler(async (c) => {
  const object = await storage.put(c.req.param('name'), await c.req.arrayBuffer(), {
    httpMetadata: { contentType: c.req.header('content-type') ?? 'application/octet-stream' },
  });
  return c.json({ key: object.key, size: object.size, etag: object.etag }, 201);
});
