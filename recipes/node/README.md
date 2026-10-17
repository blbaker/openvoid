# Recipe: plain Node.js

Run an OpenVoid app as a normal process on a VM or your own server, kept alive by systemd.

| Void API | Default | Other options |
| --- | --- | --- |
| `void/db` | SQLite file | PostgreSQL with `database: 'pg'` and `DATABASE_URL` |
| `void/kv` | SQLite file | Redis (`OPENVOID_KV=redis://...`) or DynamoDB |
| `void/storage` | Files on disk | Any S3-compatible service (`OPENVOID_STORAGE=s3://...`) |

## Files

- `openvoid.service`: a systemd unit. Edit the paths and user, then copy it to
  `/etc/systemd/system/my-app.service`.

## Steps

Build anywhere, then copy `dist/` and `package.json` to the server:

```sh
npm run build
rsync -a dist package.json server:/srv/my-app/
```

On the server, with Node.js 24 installed:

```sh
cd /srv/my-app
npm install --omit=dev          # only @hono/node-server is needed at runtime
sudo useradd --system --home /var/lib/my-app my-app
sudo mkdir -p /var/lib/my-app && sudo chown my-app: /var/lib/my-app
sudo cp openvoid.service /etc/systemd/system/my-app.service
sudo systemctl daemon-reload
sudo systemctl enable --now my-app
curl http://localhost:3000/api/health
```

Data goes to `/var/lib/my-app` (`OPENVOID_DATA_DIR`). Back it up like any SQLite database:
`sqlite3 /var/lib/my-app/db.sqlite ".backup backup.sqlite"` gives a consistent copy while the
app runs. Put Caddy or nginx in front for TLS.

On shutdown systemd sends `SIGTERM`; OpenVoid stops accepting connections and closes its
databases before exiting.

## What was tested

`scripts/e2e.sh local` runs the `notes` example this way (SQLite and files) and
`scripts/e2e.sh services` runs `notes-pg` against PostgreSQL, Redis and S3. The systemd unit
itself is not exercised by CI.
