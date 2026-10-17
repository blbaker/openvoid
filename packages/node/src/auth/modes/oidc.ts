// OIDC / OAuth 2 sign-in. Placeholder until the mode lands; see docs/identity.md.
import type { AuthMode, AuthModeContext } from '../types.ts';

export function createMode(_ctx: AuthModeContext): AuthMode {
  throw new Error('openvoid: OPENVOID_AUTH=oidc is not implemented in this build yet.');
}
