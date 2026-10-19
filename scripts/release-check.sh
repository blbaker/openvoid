#!/usr/bin/env bash
# Checks that @blbaker/openvoid is fit to publish, without publishing it. The release workflow
# runs it before every upload, and it's safe to run locally:
#
#   bash scripts/release-check.sh            pack the package and inspect the tarball
#   bash scripts/release-check.sh v0.1.1     also check the tag against the version, and that
#                                            the version isn't on npm yet
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=packages/node
TAG=${1:-}

fail() { echo "release-check: $*" >&2; exit 1; }

name=$(node -p "require('./$PKG/package.json').name")
version=$(node -p "require('./$PKG/package.json').version")

# `npm stage publish` and trusted publishing need npm 11.15.0 or later.
node -e '
  const [a, b, c] = process.argv[1].split(".").map(Number);
  process.exit(a > 11 || (a === 11 && (b > 15 || (b === 15 && c >= 0))) ? 0 : 1);
' "$(npm --version)" || fail "npm $(npm --version) is too old; staged publishing needs 11.15.0 or later"

if [ -n "$TAG" ]; then
  [ "$TAG" = "v$version" ] || fail "tag $TAG does not match $name@$version"
  # A version number can only ever be used once on npm. E404 (no such package, or no such
  # version) is the answer we want; anything else, including a network failure, stops here.
  if out=$(npm view "$name@$version" version --fetch-timeout=30000 --fetch-retries=1 2>&1); then
    [ "$out" = "$version" ] && fail "$name@$version is already on npm; bump the version"
    fail "unexpected answer from npm view: $out"
  fi
  detail=$(grep -m1 '^npm error code' <<<"$out" || head -1 <<<"$out")
  grep -q E404 <<<"$out" || fail "could not ask npm whether $name@$version exists: $detail"
fi

dest=$(mktemp -d)
trap 'rm -rf "$dest"' EXIT
# npm pack runs the package's prepack script, which builds dist/, exactly as publishing does.
(cd "$PKG" && npm pack --pack-destination "$dest" > "$dest/pack.log" 2>&1) \
  || { cat "$dest/pack.log" >&2; fail "npm pack failed"; }
tgz=$(ls "$dest"/*.tgz)
tar -tzf "$tgz" > "$dest/files"

# Every file package.json's exports point at, plus the license, must be in the tarball.
node -e '
  const { exports } = require(process.argv[1]);
  const paths = new Set(["./LICENSE", "./README.md"]);
  for (const entry of Object.values(exports)) for (const p of Object.values(entry)) paths.add(p);
  console.log([...paths].map((p) => "package/" + p.replace(/^\.\//, "")).join("\n"));
' "./$PKG/package.json" > "$dest/required"
missing=$(grep -vxFf "$dest/files" "$dest/required" || true)
[ -z "$missing" ] || fail "the tarball is missing: $(echo "$missing" | sed 's#^package/##' | tr '\n' ' ')"

! grep -qE '^package/(src|test)/' "$dest/files" || fail "the tarball ships src/ or test/"
tar -xzOf "$tgz" package/package.json > "$dest/manifest.json"
! grep -qE '"(workspace|catalog):' "$dest/manifest.json" \
  || fail "the packed package.json still has workspace: or catalog: versions"

echo "release-check: ok, $name@$version, $(wc -l < "$dest/files") files, $(du -k "$tgz" | cut -f1) KB packed"
