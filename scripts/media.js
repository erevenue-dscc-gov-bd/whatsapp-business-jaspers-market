#!/usr/bin/env node
/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

/**
 * Upload a template asset to the WhatsApp Cloud API media endpoint and record
 * the returned media ID in .env.
 *
 *   npm run media -- --file public/groceries.jpg --set GROCERIES_MEDIA_ID
 *   npm run media -- --file public/strawberries.jpg --set STRAWBERRIES_MEDIA_ID
 *
 * Media IDs are scoped to the phone number that uploaded them and expire after
 * 30 days, so re-run this and restart the app before they lapse. Use assets you
 * own; Asset Manager URLs and upload-session handles are not runtime media IDs.
 */

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const { API_BASE, graphRequest, describeGraphError } = require("./lib/graph");
const { isPlaceholder, mask, upsertEnvFile } = require("./lib/env");

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const TARGETS = [
  "GROCERIES_MEDIA_ID",
  "STRAWBERRIES_MEDIA_ID",
  "SHEET_PAN_DINNER_MEDIA_ID",
  "SALAD_BOWL_MEDIA_ID",
];

function parseArgs(argv) {
  const options = { file: undefined, set: undefined, phoneNumberId: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file" || arg === "-f") options.file = argv[++index];
    else if (arg === "--set") options.set = argv[++index];
    else if (arg === "--phone-number-id") options.phoneNumberId = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printUsage() {
  console.log(`Usage:
  npm run media -- --file <path-to-image> [--set <ENV_VAR>] [--phone-number-id <id>]

Options:
  --file             image to upload (jpg, png, or webp)
  --set              env var to update with the returned media ID, one of:
                     ${TARGETS.join("\n                     ")}
  --phone-number-id  defaults to PHONE_NUMBER_ID from .env

Environment (from .env):
  ACCESS_TOKEN, PHONE_NUMBER_ID, API_VERSION (optional, defaults to v23.0)`);
}

async function upload({ file, token, version, phoneNumberId }) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`file not found: ${resolved}`);
  }

  const mimeType = MIME_TYPES[path.extname(resolved).toLowerCase()];
  if (!mimeType) {
    throw new Error(`unsupported image type "${path.extname(resolved)}" (use jpg, png, or webp)`);
  }

  const size = fs.statSync(resolved).size;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([fs.readFileSync(resolved)], { type: mimeType }), path.basename(resolved));

  const url = `${API_BASE}/${version}/${phoneNumberId}/media`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    return { ok: response.ok, status: response.status, json, size };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      networkError: [error.message, error.cause?.code].filter(Boolean).join(": "),
    };
  } finally {
    clearTimeout(timer);
  }
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

  if (options.help || !options.file) {
    printUsage();
    return;
  }

  if (options.set && !TARGETS.includes(options.set)) {
    console.error(`--set must be one of: ${TARGETS.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const version = process.env.API_VERSION || "v23.0";
  const token = process.env.ACCESS_TOKEN;
  const phoneNumberId = options.phoneNumberId || process.env.PHONE_NUMBER_ID;

  if (isPlaceholder(token)) {
    console.error("ACCESS_TOKEN is not set in .env");
    process.exitCode = 1;
    return;
  }
  if (isPlaceholder(phoneNumberId)) {
    console.error("PHONE_NUMBER_ID is not set in .env (find it with: npm run webhook -- phones)");
    process.exitCode = 1;
    return;
  }

  console.log(`Uploading ${path.relative(process.cwd(), path.resolve(options.file))} for phone number ${phoneNumberId}...`);
  const result = await upload({ file: options.file, token, version, phoneNumberId });

  if (result.networkError) {
    console.error(`Upload failed: network error: ${result.networkError}`);
    console.error(`(${API_BASE} must be reachable from this host)`);
    process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    console.error(`Upload failed: ${describeGraphError(result)}`);
    process.exitCode = 1;
    return;
  }

  const mediaId = result.json?.id;
  console.log(`Uploaded ${result.size} bytes; media id ${mediaId}`);
  console.log("Media IDs expire after 30 days; re-upload and restart before they lapse.");

  if (options.set) {
    upsertEnvFile({ [options.set]: mediaId });
    console.log(`Saved ${options.set}=${mask(mediaId)} to .env (restart the app to pick it up).`);
  } else {
    console.log("Pass --set <ENV_VAR> to record this ID in .env.");
  }

  // Remind the operator which of the four runtime assets are still missing.
  const missing = TARGETS.filter((key) => isPlaceholder(process.env[key]) && key !== options.set);
  if (missing.length > 0) {
    console.log(`Still missing: ${missing.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
