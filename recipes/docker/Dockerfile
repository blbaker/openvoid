# syntax=docker/dockerfile:1
# Run a built OpenVoid app in a container.
#
# Copy this file to your app's root, build the app first (`npm run build`), then:
#   docker build -t my-app .
#   docker run -p 3000:3000 -v my-app-data:/data my-app
#
# The image only needs the built `dist/` folder. Void bundles your routes and OpenVoid bundles its
# backends (SQLite, Redis, DynamoDB, S3 clients), so the one runtime package is @hono/node-server.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    OPENVOID_DATA_DIR=/data

# "type": "module" lets Node load the bundle's .js files as ES modules.
RUN echo '{"private":true,"type":"module"}' > package.json \
 && npm install --omit=dev --no-audit --no-fund --loglevel=error @hono/node-server@2.1.5 \
 && mkdir -p /data && chown node:node /data

COPY dist ./dist

USER node
VOLUME /data
EXPOSE 3000

# Pending migrations (db/migrations, bundled at build time) run before the server listens.
CMD ["node", "dist/ssr/index.js"]
