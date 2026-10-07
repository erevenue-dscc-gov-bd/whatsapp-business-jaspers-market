# Local / Sandbox Setup Notes

Notes for running this sample outside of Meta's hosting environment. See
[README.md](README.md) for the full Meta app, template, and webhook setup.

## Requirements

- Node 18.19+ (verified with Node 22)
- Redis server (required: the app connects on startup and crashes without it)
- A tunneling service such as ngrok, or a public host reachable by Meta

## Steps

```bash
npm install
cp .sample.env .env      # then fill in real credentials and media IDs
redis-server --daemonize yes
node app.js              # listens on PORT (default 8080)
npm test                 # 25 unit tests
```

### Redis without a system package

If your environment has no Redis package (for example a container without
`apt` write access), build it from source instead:

```bash
curl -sSL -o redis.tar.gz https://codeload.github.com/redis/redis/tar.gz/refs/tags/7.4.2
tar xzf redis.tar.gz && cd redis-7.4.2
make -j2 MALLOC=libc
src/redis-server --port 6379 --save '' --appendonly no
```

Point `REDIS_HOST` / `REDIS_PORT` in `.env` at that instance if the defaults differ.

## Verifying without a live WhatsApp number

`config.checkEnvVariables()` rejects blank/placeholder media IDs, so use any
non-placeholder value in `.env` to boot locally. Outbound Graph API calls will
then fail, but the local routes can still be exercised:

- `GET /` — health check, returns JSON
- `GET /webhook?hub.mode=subscribe&hub.verify_token=$VERIFY_TOKEN&hub.challenge=X`
  — webhook handshake; `403` when the token does not match
- `POST /webhook` — inbound messages, signed with `x-hub-signature-256`
  (HMAC-SHA256 of the raw body using `APP_SECRET`)

The shipped `.env` is gitignored and must never be committed.
