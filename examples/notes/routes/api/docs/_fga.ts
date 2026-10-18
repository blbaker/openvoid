// Not a route: files/dirs starting with `_` are ignored by Void's router (see
// node_modules/void/docs/guide/server-routing.md). A tiny per-request helper so modes with no
// sign-in event of their own (proxy: identity is presented fresh on every request, there is no
// callback to hook) still keep OpenFGA group membership in sync when OPENVOID_FGA_SYNC_GROUPS=1.
// See recipes/authz-openfga, "Group sync with identity providers", for the full explanation and
// the alternative (a mode that does fire onSignIn, such as oidc or better-auth).
import { getUser } from '@openvoid/node/auth';
import { onSignIn } from '@openvoid/node/fga';

export async function syncSignedInGroups(): Promise<void> {
  const user = getUser();
  if (user) await onSignIn(user, process.env);
}
