// Connect-style middleware for the Vite dev and preview servers, which speak Node's
// IncomingMessage/ServerResponse instead of fetch Request/Response.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { runWithSession } from './context.ts';
import type { Auth } from './handler.ts';

function toRequest(req: IncomingMessage, withBody: boolean): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  const hasBody = withBody && req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') res.setHeader(key, value);
  });
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  }
  res.end();
}

export function authMiddleware(auth: Auth) {
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const isAuth = auth.isAuthPath(pathname);
    const request = toRequest(req, isAuth);
    if (isAuth) {
      auth.handle(request).then((response) => writeResponse(res, response), next);
      return;
    }
    auth.resolve(request).then(
      (session) => runWithSession(session, auth.basePath, () => next()),
      next,
    );
  };
}
