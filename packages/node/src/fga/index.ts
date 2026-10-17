// OpenFGA authorization. Placeholder until the module lands; see docs/identity.md.
import type { AuthUser, Vars } from '../auth/types.ts';

/** Create the store if needed and write fga/model.fga when it changed. Runs with `migrate`. */
export async function migrateFga(_vars: Vars, _modelSource: string | null): Promise<void> {
  throw new Error('openvoid: OPENVOID_FGA_URL is set but OpenFGA support is not implemented in this build yet.');
}

/** Called after every sign-in, e.g. to mirror the user's groups into OpenFGA. */
export async function onSignIn(_user: AuthUser, _vars: Vars): Promise<void> {}
