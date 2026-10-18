import type { AuthUser } from '../auth/types.ts';
import { encodeFgaId } from './ids.ts';

/** `user:<id>` for an AuthUser, or a raw AuthUser.id string (e.g. "github:12345"). */
export function fgaUser(user: string | AuthUser): string {
  const id = typeof user === 'string' ? user : user.id;
  return `user:${encodeFgaId(id)}`;
}
