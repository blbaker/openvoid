// OpenFGA authorization. See docs/identity.md ("Authorization with OpenFGA") and
// recipes/authz-openfga for the full picture; this file just wires the pieces together.
//
//   migrateFga(vars, modelSource)   creates the store and writes fga/model.fga; runs with `migrate`
//   onSignIn(user, vars)            mirrors groups into OpenFGA when OPENVOID_FGA_SYNC_GROUPS=1
//   check / requirePermission / listObjects / grant / revoke / writeTuples / deleteTuples / fgaUser
//                                   the runtime API routes import from `@openvoid/node/fga`
export { migrateFga } from './model.ts';
export { onSignIn } from './sync.ts';
export { fgaUser } from './user.ts';
export { check, requirePermission, listObjects, grant, revoke, writeTuples, deleteTuples } from './runtime.ts';
export type { FgaTuple, FgaCheckOptions, FgaGrantOptions } from './runtime.ts';
export { encodeFgaId, decodeFgaId } from './ids.ts';
export { resetFgaContextCache } from './client.ts';
