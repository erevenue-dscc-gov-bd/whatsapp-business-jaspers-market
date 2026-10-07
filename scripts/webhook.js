#!/usr/bin/env node
/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

/**
 * Manage the WhatsApp Business Account webhook subscription.
 *
 *   npm run webhook -- status
 *   npm run webhook -- subscribe --callback-url https://example.ngrok.app
 *   npm run webhook -- unsubscribe
 *   npm run webhook -- phones
 *
 * The callback URL is read from --callback-url, or WEBHOOK_CALLBACK_URL in
 * .env when omitted. Access tokens are sent only as Authorization headers.
 */

require("dotenv").config();

const { graphRequest, describeGraphError } = require("./lib/graph");
const { isPlaceholder, upsertEnvFile } = require("./lib/env");

function parseArgs(argv) {
  const options = { command: argv[0], callbackUrl: undefined, verifyToken: undefined };
  if (argv[0] === "--help" || argv[0] === "-h") {
    options.help = true;
    options.command = undefined;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--callback-url") options.callbackUrl = argv[++index];
    else if (arg === "--verify-token") options.verifyToken = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printUsage() {
  console.log(`Usage:
  npm run webhook -- status
  npm run webhook -- subscribe [--callback-url https://your-public-host]
  npm run webhook -- unsubscribe
  npm run webhook -- phones

Environment (from .env):
  ACCESS_TOKEN           system user token
  WABA_ID                WhatsApp Business Account id
  VERIFY_TOKEN           webhook handshake passphrase
  WEBHOOK_CALLBACK_URL   optional, public HTTPS base URL
  API_VERSION            optional, defaults to v23.0`);
}

function requireConfig({ needsCallbackUrl = false } = {}) {
  const version = process.env.API_VERSION || "v23.0";
  const token = process.env.ACCESS_TOKEN;
  const wabaId = process.env.WABA_ID;

  if (isPlaceholder(token)) throw new Error("ACCESS_TOKEN is not set in .env");
  if (isPlaceholder(wabaId)) throw new Error("WABA_ID is not set in .env (Meta Business Suite > WhatsApp Accounts)");

  const config = { version, token, wabaId };
  if (needsCallbackUrl) {
    const verifyToken = process.env.VERIFY_TOKEN;
    if (isPlaceholder(verifyToken)) throw new Error("VERIFY_TOKEN is not set in .env");
    config.verifyToken = verifyToken;
  }
  return config;
}

function normalizeCallbackUrl(input) {
  if (!input) return undefined;
  const url = new URL(input.trim());
  if (url.protocol !== "https:") {
    throw new Error(`Meta requires an HTTPS callback URL, got ${url.protocol}//`);
  }
  // Normalize to the base URL; the app serves /webhook.
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function status() {
  const { version, token, wabaId } = requireConfig();
  const result = await graphRequest({ version, path: `${wabaId}/subscribed_apps`, token });

  if (!result.ok) {
    throw new Error(`could not read subscription: ${describeGraphError(result)}`);
  }

  const apps = result.json?.data || [];
  if (apps.length === 0) {
    console.log(`No app is subscribed to WABA ${wabaId}.`);
    console.log("Run: npm run webhook -- subscribe --callback-url https://your-public-host");
    return;
  }

  console.log(`WABA ${wabaId} has ${apps.length} subscribed app(s):`);
  for (const app of apps) {
    const name = app.whatsapp_business_api_data?.name || "(unnamed)";
    const link = app.whatsapp_business_api_data?.link || "";
    console.log(`  - ${name} id=${app.id} ${link}`);
  }
}

async function subscribe(options) {
  const { version, token, wabaId, verifyToken } = requireConfig({ needsCallbackUrl: true });
  const rawCallback = options.callbackUrl || process.env.WEBHOOK_CALLBACK_URL;
  if (isPlaceholder(rawCallback)) {
    throw new Error("no callback URL: pass --callback-url or set WEBHOOK_CALLBACK_URL in .env");
  }

  const callbackUrl = normalizeCallbackUrl(rawCallback);
  const subscription = { override_callback_uri: callbackUrl, verify_token: options.verifyToken || verifyToken };

  // Graph accepts these as body params; fall back to the query string, which
  // some endpoint revisions read instead.
  let result = await graphRequest({
    version,
    path: `${wabaId}/subscribed_apps`,
    method: "POST",
    token,
    body: subscription,
  });

  if (!result.ok && !result.networkError) {
    result = await graphRequest({
      version,
      path: `${wabaId}/subscribed_apps`,
      method: "POST",
      token,
      query: subscription,
    });
  }

  if (!result.ok) {
    throw new Error(`subscribe failed: ${describeGraphError(result)}`);
  }

  upsertEnvFile({ WEBHOOK_CALLBACK_URL: callbackUrl }, { appendHeading: "Webhook tunnelling" });

  console.log(`Subscribed to WABA ${wabaId}.`);
  console.log(`  override callback URI: ${callbackUrl}/webhook`);
  console.log("  WEBHOOK_CALLBACK_URL saved to .env");
  console.log("\nMeta will send a verification GET to that URL now. The tunnel and this server must be running.");
}

async function unsubscribe() {
  const { version, token, wabaId } = requireConfig();
  const result = await graphRequest({
    version,
    path: `${wabaId}/subscribed_apps`,
    method: "DELETE",
    token,
  });

  if (!result.ok) {
    throw new Error(`unsubscribe failed: ${describeGraphError(result)}`);
  }
  console.log(`Unsubscribed this app from WABA ${wabaId}.`);
}

async function phones() {
  const { version, token, wabaId } = requireConfig();
  const result = await graphRequest({
    version,
    path: `${wabaId}/phone_numbers`,
    token,
    query: { fields: "id,display_phone_number,verified_name,quality_rating" },
  });

  if (!result.ok) {
    throw new Error(`could not list phone numbers: ${describeGraphError(result)}`);
  }

  const list = result.json?.data || [];
  if (list.length === 0) {
    console.log(`No phone numbers on WABA ${wabaId}.`);
    return;
  }

  console.log(`Phone numbers on WABA ${wabaId}:`);
  for (const phone of list) {
    console.log(`  - ${phone.display_phone_number}  id=${phone.id}  ${phone.verified_name || ""} ${phone.quality_rating || ""}`);
  }
  console.log("\nUse the id above as PHONE_NUMBER_ID for media uploads.");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (options.help || !options.command) {
    printUsage();
    return;
  }

  try {
    switch (options.command) {
      case "status":
        await status();
        break;
      case "subscribe":
        await subscribe(options);
        break;
      case "unsubscribe":
        await unsubscribe();
        break;
      case "phones":
        await phones();
        break;
      default:
        console.error(`Unknown command: ${options.command}`);
        printUsage();
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
