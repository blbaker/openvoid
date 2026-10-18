# Authelia + Caddy forward-auth, for trying it out

See `../README.md` first; this is the detail for setup 2 there. Everything in this folder is
for local dev/test: the password, the session/storage/JWT secrets in `configuration.yml`, and
Caddy's self-signed `tls internal` certificate.

```sh
npm run build
export OPENVOID_AUTH_PROXY_SECRET=$(openssl rand -hex 32)
docker compose -f compose.authelia.yaml up -d --build
curl -k https://app.localtest.me:3442/api/me   # 302 to Authelia; nobody is signed in yet
```

Sign in without a browser, using Authelia's own JSON login API (the same one its PAM and Home
Assistant integrations use):

```sh
curl -k -c /tmp/authelia-cookies.txt -X POST -H 'content-type: application/json' \
  -d '{"username":"marty","password":"marty-mcfly-1985"}' \
  https://auth.localtest.me:3442/api/firstfactor
curl -k -b /tmp/authelia-cookies.txt https://app.localtest.me:3442/api/me
```

That last call should come back as `marty`, in groups `family` and `admins`. See
`../README.md`'s "What was tested" for exactly what this setup has and hasn't been checked
against.
