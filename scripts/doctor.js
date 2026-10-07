#!/usr/bin/env node
/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

/**
 * Preflight check for a Jasper's Market deployment.
 *
 *   npm run doctor
 *
 * Verifies local configuration, Redis, the Graph API token, the WhatsApp
 * Business Account webhook subscription, and the public callback URL.
 * Secrets are never printed: only masked forms and lengths.
 */

const net = require("node:net");
const path = require("node:path");

require("dotenv").config();

const { API_BASE, graphRequest, describeGraphError } = require("./lib/graph");
const { ENV_PATH, SAMPLE_ENV_PATH, isPlaceholder, mask } = require("./lib/env");

const REQUIRED_SECRETS = [
  ["ACCESS_TOKEN", "System user access token used to send messages"],
  ["APP_SECRET", "App secret used to verify webhook signatures"],
  ["VERIFY_TOKEN", "Passphrase for the webhook subscription handshake"],
];

const REQUIRED_MEDIA = [
  "GROCERIES_MEDIA_ID",
  "STRAWBERRIES_MEDIA_ID",
  "SHEET_PAN_DINNER_MEDIA_ID",
  "SALAD_BOWL_MEDIA_ID",
];

const results = [];
function record(status, label, detail) {
  results.push({ status, label, detail });
  const icon = status === "pass" ? "\u2713" : status === "warn" ? "!" : "\u2717";
  const suffix = detail ? ` \u2014 ${detail}` : "";
  console.log(`  ${icon} ${label}${suffix}`);
}

const section = (title) => console.log(`\n${title}`);

async function checkNode() {
  section("Runtime");
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  if (major > 18 || (major === 18 && minor >= 19)) {
    record("pass", `Node ${process.versions.node}`);
  } else {
    record("fail", `Node ${process.versions.node}`, "18.19 or higher is required");
  }
}

function checkEnvFile() {
  section("Configuration");
  if (require("node:fs").existsSync(ENV_PATH)) {
    record("pass", ".env present");
  } else {
    record("fail", ".env missing", `run: cp ${path.relative(process.cwd(), SAMPLE_ENV_PATH)} .env`);
  }

  for (const [key, purpose] of REQUIRED_SECRETS) {
    const value = process.env[key];
    if (isPlaceholder(value)) {
      record("fail", `${key} not set`, purpose);
    } else {
      record("pass", `${key} ${mask(value)}`);
    }
  }

  const invalidMedia = REQUIRED_MEDIA.filter((key) => isPlaceholder(process.env[key]));
  if (invalidMedia.length === 0) {
    record("pass", "all four media IDs look real");
  } else {
    record("fail", `media IDs missing or placeholder`, invalidMedia.join(", "));
  }

  // Optional identifiers only the tooling and tunnelling need.
  for (const [key, purpose] of [
    ["WABA_ID", "WhatsApp Business Account id, needed to register the webhook"],
    ["PHONE_NUMBER_ID", "sender phone number id, needed for media uploads"],
    ["WEBHOOK_CALLBACK_URL", "public HTTPS URL Meta should call"],
  ]) {
    if (isPlaceholder(process.env[key])) {
      record("warn", `${key} not set`, purpose);
    } else {
      record("pass", `${key} = ${process.env[key]}`);
    }
  }
}

function checkRedis() {
  section("Redis");
  const host = process.env.REDIS_HOST || "localhost";
  const port = Number(process.env.REDIS_PORT || 6379);

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    let buffer = "";

    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      record(status, `Redis at ${host}:${port}`, detail);
      resolve();
    };

    socket.setTimeout(3000);
    socket.on("timeout", () => finish("fail", "timed out; is redis-server running?"));
    socket.on("error", (error) => finish("fail", error.code || error.message));
    socket.on("connect", () => socket.write("PING\r\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes("PONG")) finish("pass", "PING answered");
      else if (buffer.startsWith("-")) finish("fail", buffer.trim());
    });
    socket.on("end", () => finish("pass", "connection closed"));
  });
}

async function checkLocalServer() {
  section("Local server");
  const port = process.env.PORT || 8080;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    clearTimeout(timer);
    record(response.ok ? "pass" : "fail", `GET http://127.0.0.1:${port}/`, `HTTP ${response.status}`);
  } catch (error) {
    record("warn", `GET http://127.0.0.1:${port}/`, `not running (${error.cause?.code || error.message})`);
  }
}

async function checkGraphAccess() {
  section("Graph API");
  const version = process.env.API_VERSION || "v23.0";
  const token = process.env.ACCESS_TOKEN;

  if (isPlaceholder(token)) {
    record("fail", "Graph API token check", "ACCESS_TOKEN is not set");
    return;
  }

  const whoami = await graphRequest({ version, path: "me", token, query: { fields: "id,name" } });
  if (whoami.ok) {
    record("pass", `token accepted by ${API_BASE}/${version}`, `id ${whoami.json?.id ?? "unknown"}`);
  } else if (whoami.networkError) {
    record(
      "fail",
      `cannot reach ${API_BASE}`,
      `${describeGraphError(whoami)} (outbound HTTPS is blocked in this sandbox)`,
    );
    return;
  } else {
    record("fail", "token rejected", describeGraphError(whoami));
    return;
  }

  const wabaId = process.env.WABA_ID;
  if (isPlaceholder(wabaId)) {
    record("warn", "WABA webhook subscription", "WABA_ID is not set");
    return;
  }

  const phones = await graphRequest({
    version,
    path: `${wabaId}/phone_numbers`,
    token,
    query: { fields: "id,display_phone_number,verified_name" },
  });
  if (phones.ok) {
    const list = phones.json?.data || [];
    record(
      "pass",
      `phone numbers on WABA ${wabaId}`,
      list.map((entry) => `${entry.display_phone_number} (${entry.id})`).join(", ") || "none returned",
    );
  } else {
    record("fail", `cannot list phone numbers for WABA ${wabaId}`, describeGraphError(phones));
  }

  const subscribed = await graphRequest({ version, path: `${wabaId}/subscribed_apps`, token });
  if (subscribed.ok) {
    const apps = subscribed.json?.data || [];
    if (apps.length > 0) {
      record(
        "pass",
        "webhook subscription active",
        apps.map((app) => `${app.whatsapp_business_api_data?.name || app.id} (${app.id})`).join(", "),
      );
    } else {
      record("fail", "no app subscribed to this WABA", "run: npm run webhook -- subscribe --callback-url <url>");
    }
  } else {
    record("fail", "cannot read webhook subscription", describeGraphError(subscribed));
  }
}

async function probeHandshake(baseUrl, { timeoutMs = 10000 } = {}) {
  const url = new URL("/webhook", baseUrl);
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", process.env.VERIFY_TOKEN);
  url.searchParams.set("hub.challenge", "doctor-probe");

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const body = (await response.text()).trim();
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, error: error.cause?.code || error.message };
  }
}

/** True for hosts that only resolve for external clients, such as sandbox previews. */
function isSandboxPreview(baseUrl) {
  const host = new URL(baseUrl).hostname;
  return host.endsWith(".e2b.app") || host.endsWith(".e2b.dev");
}

async function checkWebhookHandshake() {
  section("Webhook handshake");
  const port = process.env.PORT || 8080;
  const local = await probeHandshake(`http://127.0.0.1:${port}`, { timeoutMs: 3000 });

  if (local.status === 200 && local.body === "doctor-probe") {
    record("pass", `local handshake ok (VERIFY_TOKEN accepted)`, `http://127.0.0.1:${port}/webhook`);
  } else if (local.status === 403) {
    record("fail", "local handshake rejected (403)", "the running server uses a different VERIFY_TOKEN; restart it after changing .env");
  } else if (local.status === 0) {
    record("fail", "local handshake unreachable", `${local.error}; is the server running?`);
  } else {
    record("fail", `local handshake returned HTTP ${local.status}`, local.body.slice(0, 120) || "empty body");
  }

  const callbackUrl = process.env.WEBHOOK_CALLBACK_URL;
  if (isPlaceholder(callbackUrl)) {
    record("warn", "WEBHOOK_CALLBACK_URL not set", "run: npm run tunnel");
    return;
  }

  const publicProbe = await probeHandshake(callbackUrl);

  if (publicProbe.status === 200 && publicProbe.body === "doctor-probe") {
    record("pass", "public callback URL answers the handshake", callbackUrl);
  } else if (isSandboxPreview(callbackUrl)) {
    record(
      "warn",
      "sandbox preview URL not probeable from inside",
      `${callbackUrl} only resolves for external clients; open it in a browser to confirm`,
    );
  } else if (publicProbe.status === 403) {
    record("fail", "public handshake rejected (403)", "VERIFY_TOKEN does not match the running server");
  } else if (publicProbe.status === 0) {
    record("fail", `cannot reach ${callbackUrl}`, `${publicProbe.error}; is the tunnel up?`);
  } else {
    record("fail", `public handshake returned HTTP ${publicProbe.status}`, publicProbe.body.slice(0, 120) || "empty body");
  }
}

async function main() {
  console.log("Jasper's Market doctor");
  console.log("======================");

  await checkNode();
  checkEnvFile();
  await checkRedis();
  await checkLocalServer();
  await checkGraphAccess();
  await checkWebhookHandshake();

  const failures = results.filter((entry) => entry.status === "fail");
  const warnings = results.filter((entry) => entry.status === "warn");

  console.log("\nSummary");
  console.log(`  ${results.filter((r) => r.status === "pass").length} passed, ${warnings.length} warnings, ${failures.length} failures`);

  if (failures.length > 0) {
    console.log("\nNext steps:");
    for (const failure of failures) {
      console.log(`  - ${failure.label}${failure.detail ? `: ${failure.detail}` : ""}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("doctor crashed:", error);
  process.exitCode = 1;
});
