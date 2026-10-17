import { defineHandler } from 'void';
import { env } from 'void/env';

export const GET = defineHandler(() => ({ ok: true, app: env.APP_NAME, runtime: `node ${process.version}` }));
