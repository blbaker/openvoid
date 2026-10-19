# Releasing @blbaker/openvoid

Releases go out from GitHub Actions with npm trusted publishing. The release workflow proves who
it is to npm with a short-lived OIDC token, so no npm token lives in this repo or its secrets.
CI only stages a version. Nobody can install it until a maintainer approves it on npm with 2FA.

## One-time setup

npm only attaches a trusted publisher to a package that already exists, so the first version is
published by hand.

1. Create the `npm` environment: repo Settings, Environments, New environment, name it `npm`.
   Under "Deployment branches and tags" pick "Selected branches and tags" and add a tag rule for
   `v*`. Without the rule, any branch could run a job in that environment.
2. Publish the first version from a clean checkout of `main`:

   ```sh
   npm login
   bash scripts/release-check.sh v0.1.0
   cd packages/node && npm publish
   ```

   This version has no provenance statement, because it wasn't built in CI.
3. Connect the package to the workflow. Do this when the next release is ready: npm expires a
   trusted publisher that hasn't published anything within 2 days.

   ```sh
   npm trust github @blbaker/openvoid --repo blbaker/openvoid --file release.yml --env npm --allow-stage-publish
   ```

   The same form is on npmjs.com under the package's Settings, Trusted publishing. Leaving out
   `--allow-publish` means CI can stage a version but never publish one directly.
4. Optional, once a CI release has worked: in the package's Settings, Publishing access, choose
   "Require two-factor authentication and disallow tokens". From then on a version only goes
   live through a 2FA login.

## Cutting a release

1. Bump `version` in `packages/node/package.json` in a pull request and merge it.
2. Tag the merge commit and push the tag:

   ```sh
   git fetch origin && git tag v0.1.1 origin/main && git push origin v0.1.1
   ```

3. The release workflow checks that the tag matches the version, the commit is on `main`, the
   version isn't on npm yet, and the tarball holds every file `package.json` exports. Then it
   runs `npm stage publish`.
4. Approve it: `npm stage list @blbaker/openvoid`, then `npm stage approve <stage-id>`, or use
   the Staged Packages tab on npmjs.com. Both ask for 2FA.

If the publish step fails with `ENEEDAUTH`, the trusted publisher doesn't match the workflow. npm
compares the repository, the workflow file name and the environment exactly, case included.

`bash scripts/release-check.sh` runs the package checks locally without publishing anything.
Pull requests that touch the package run it too.
