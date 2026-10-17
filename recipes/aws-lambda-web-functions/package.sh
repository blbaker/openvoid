#!/usr/bin/env bash
# Package a built OpenVoid app as a Lambda Web Functions deployment directory (and .zip).
#
#   recipes/aws-lambda-web-functions/package.sh <app-dir> [out-dir]
#
# <app-dir> must already be built (`npm run build`, which runs `vite build` with openvoid()).
# The result has index.js at its root, which is the file Lambda Web Functions starts by default.
set -euo pipefail

APP_DIR=$(cd "${1:?usage: package.sh <app-dir> [out-dir]}" && pwd)
OUT_DIR=${2:-"$APP_DIR/.lambda"}
HONO_NODE_SERVER_VERSION=${HONO_NODE_SERVER_VERSION:-2.1.5}

if [ ! -f "$APP_DIR/dist/ssr/index.js" ]; then
  echo "error: $APP_DIR/dist/ssr/index.js not found. Run the app's build first." >&2
  exit 1
fi
if ! grep -q 'startServer' "$APP_DIR/dist/ssr/index.js"; then
  echo "error: dist/ssr/index.js was not built with openvoid(). Add it to vite.config.ts before voidPlugin()." >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$APP_DIR/dist" "$OUT_DIR/dist"

# "type": "module" makes Node treat the bundle's .js files as ES modules.
cat > "$OUT_DIR/package.json" <<EOF
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@hono/node-server": "$HONO_NODE_SERVER_VERSION"
  }
}
EOF

# Lambda Web Functions loads index.js at the package root.
cat > "$OUT_DIR/index.js" <<'EOF'
// Entry for AWS Lambda Web Functions. The server reads AWS_LAMBDA_HTTP_ENDPOINT and listens there.
import './dist/ssr/index.js';
EOF

# The bundle is plain JavaScript; @hono/node-server is the only runtime dependency Void keeps
# external, and it has no native code, so packaging on x86_64 is fine for Lambda's arm64.
(cd "$OUT_DIR" && npm install --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error)

if command -v zip >/dev/null 2>&1; then
  (cd "$OUT_DIR" && rm -f ../"$(basename "$OUT_DIR")".zip && zip -qr ../"$(basename "$OUT_DIR")".zip .)
  echo "zip:  $(dirname "$OUT_DIR")/$(basename "$OUT_DIR").zip ($(du -h "$(dirname "$OUT_DIR")/$(basename "$OUT_DIR").zip" | cut -f1))"
fi
echo "dir:  $OUT_DIR ($(du -sh "$OUT_DIR" | cut -f1))"
