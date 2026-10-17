import { defineHandler } from 'void';
import { requireAuth } from '@openvoid/node/auth';

// Signed-in user, or 401. Works with every OPENVOID_AUTH mode.
export const GET = defineHandler(() => {
  const user = requireAuth();
  return { id: user.id, provider: user.provider, email: user.email, name: user.name, groups: user.groups };
});
