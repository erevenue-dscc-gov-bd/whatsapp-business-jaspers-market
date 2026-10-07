#!/usr/bin/env bash
#
# Copyright 2021-present, Facebook, Inc. All rights reserved.
#
# This source code is licensed under the BSD-style license found in the
# LICENSE file in the root directory of this source tree.
#
# Expose the local webhook server on a public HTTPS URL, ngrok style, and save
# that URL as WEBHOOK_CALLBACK_URL in .env.
#
#   npm run tunnel                 # auto: ngrok -> cloudflared -> sandbox preview
#   npm run tunnel -- --ngrok      # force ngrok
#   npm run tunnel -- --cloudflared
#   npm run tunnel -- --preview    # use this sandbox's public preview URL
#   npm run tunnel -- --url https://your-host   # use a URL you already have
#   npm run tunnel -- --print      # only print the URL, do not write .env
#
# After the tunnel is up, register it with Meta:
#   npm run webhook -- subscribe

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
PORT="${PORT:-$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)}"
PORT="${PORT:-8080}"

MODE="auto"
EXPLICIT_URL=""
WRITE_ENV=1
LOG_FILE="$(mktemp -t jaspers-tunnel-XXXXXX.log)"

usage() {
  sed -n '11,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ngrok) MODE="ngrok" ;;
    --cloudflared) MODE="cloudflared" ;;
    --preview) MODE="preview" ;;
    --url) EXPLICIT_URL="${2:-}"; MODE="url"; shift ;;
    --print) WRITE_ENV=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

have() { command -v "$1" >/dev/null 2>&1; }

save_url() {
  local url="${1%/}"
  if [[ -z "$url" ]]; then
    echo "No URL to save." >&2
    exit 1
  fi

  echo
  echo "Public webhook base URL: $url"
  echo "Webhook endpoint Meta should reach: $url/webhook"

  if [[ "$WRITE_ENV" -eq 1 ]]; then
    if [[ -f "$ENV_FILE" ]]; then
      if grep -qE '^WEBHOOK_CALLBACK_URL=' "$ENV_FILE"; then
        tmp="$(mktemp)"
        sed "s|^WEBHOOK_CALLBACK_URL=.*|WEBHOOK_CALLBACK_URL=$url|" "$ENV_FILE" > "$tmp"
        mv "$tmp" "$ENV_FILE"
      else
        printf '\n# Webhook tunnelling\nWEBHOOK_CALLBACK_URL=%s\n' "$url" >> "$ENV_FILE"
      fi
      echo "Saved WEBHOOK_CALLBACK_URL to .env"
    else
      echo "No .env found; run 'cp .sample.env .env' first, then re-run to save the URL." >&2
    fi
  fi

  echo
  echo "Next steps:"
  echo "  1. Keep this tunnel running."
  echo "  2. Register the URL with Meta:  npm run webhook -- subscribe"
  echo "  3. Verify everything:           npm run doctor"
}

start_ngrok() {
  if ! have ngrok; then
    return 1
  fi

  echo "Starting ngrok on port $PORT..." >&2
  ngrok http "$PORT" --log=stdout > "$LOG_FILE" 2>&1 &
  NGROK_PID=$!
  trap 'kill "$NGROK_PID" 2>/dev/null || true' EXIT

  local url=""
  for _ in $(seq 1 30); do
    url="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
      | grep -o 'https://[a-zA-Z0-9._-]*\.ngrok[a-zA-Z0-9._-]*' | head -1 || true)"
    [[ -n "$url" ]] && break
    if ! kill -0 "$NGROK_PID" 2>/dev/null; then
      echo "ngrok exited; log follows:" >&2
      cat "$LOG_FILE" >&2
      return 1
    fi
    sleep 1
  done

  if [[ -z "$url" ]]; then
    echo "ngrok did not report a public URL within 30s." >&2
    tail -20 "$LOG_FILE" >&2 || true
    return 1
  fi

  echo "$url"
  wait "$NGROK_PID"
}

start_cloudflared() {
  if ! have cloudflared; then
    return 1
  fi

  echo "Starting a Cloudflare quick tunnel on port $PORT..." >&2
  cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate > "$LOG_FILE" 2>&1 &
  CLOUDFLARED_PID=$!
  trap 'kill "$CLOUDFLARED_PID" 2>/dev/null || true' EXIT

  local url=""
  for _ in $(seq 1 30); do
    url="$(grep -o 'https://[a-zA-Z0-9._-]*\.trycloudflare\.com' "$LOG_FILE" | head -1 || true)"
    [[ -n "$url" ]] && break
    if ! kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
      echo "cloudflared exited; log follows:" >&2
      cat "$LOG_FILE" >&2
      return 1
    fi
    sleep 1
  done

  if [[ -z "$url" ]]; then
    echo "cloudflared did not report a public URL within 30s." >&2
    tail -20 "$LOG_FILE" >&2 || true
    return 1
  fi

  echo "$url"
  wait "$CLOUDFLARED_PID"
}

sandbox_preview_url() {
  if [[ -n "${E2B_SANDBOX_ID:-}" ]]; then
    echo "https://${PORT}-${E2B_SANDBOX_ID}.e2b.app"
    return 0
  fi
  return 1
}

case "$MODE" in
  url)
    save_url "$EXPLICIT_URL"
    ;;
  ngrok)
    url="$(start_ngrok)" || { echo "ngrok is not available." >&2; exit 1; }
    save_url "$url"
    ;;
  cloudflared)
    url="$(start_cloudflared)" || { echo "cloudflared is not available." >&2; exit 1; }
    save_url "$url"
    ;;
  preview)
    if ! url="$(sandbox_preview_url)"; then
      echo "Not running inside a sandbox with a preview URL (E2B_SANDBOX_ID is unset)." >&2
      exit 1
    fi
    save_url "$url"
    ;;
  auto)
    if have ngrok; then
      url="$(start_ngrok)" || { echo "ngrok failed; falling back." >&2; url=""; }
      [[ -n "$url" ]] && { save_url "$url"; exit 0; }
    fi
    if have cloudflared; then
      url="$(start_cloudflared)" || { echo "cloudflared failed; falling back." >&2; url=""; }
      [[ -n "$url" ]] && { save_url "$url"; exit 0; }
    fi
    if url="$(sandbox_preview_url)"; then
      echo "Neither ngrok nor cloudflared is installed; using this sandbox's public preview URL."
      echo "(In a sandbox, ngrok and cloudflared cannot reach their own control planes anyway."
      echo " Install one of them, or run this on a host with unrestricted outbound HTTPS.)"
      save_url "$url"
      exit 0
    fi
    echo "No tunnelling method available." >&2
    echo "Install ngrok (https://ngrok.com/download) or cloudflared, or pass --url https://your-host" >&2
    exit 1
    ;;
esac
