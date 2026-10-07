/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const ENV_PATH = path.join(ROOT, ".env");
const SAMPLE_ENV_PATH = path.join(ROOT, ".sample.env");

const PLACEHOLDER_PREFIXES = ["ADD_", "<", "YOUR_", "CHANGEME"];
const PLACEHOLDER_VALUES = new Set(["1234567890"]);

/** Parse an env file into an ordered list of {key, value, raw, comment} lines. */
function parseEnvFile(contents) {
  const entries = [];

  for (const line of contents.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) {
      entries.push({ type: "pair", key: match[1], value: stripQuotes(match[2].trim()) });
    } else {
      entries.push({ type: "other", text: line });
    }
  }

  return entries;
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Read a key/value map from an env file. Missing files yield an empty map. */
function readEnvFile(filePath = ENV_PATH) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const entry of parseEnvFile(fs.readFileSync(filePath, "utf8"))) {
    if (entry.type === "pair") {
      values[entry.key] = entry.value;
    }
  }
  return values;
}

/**
 * Set keys in an env file, preserving comments and ordering. Existing keys are
 * updated in place; new keys are appended under an optional trailing comment.
 */
function upsertEnvFile(updates, { filePath = ENV_PATH, appendHeading } = {}) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const entries = parseEnvFile(existing);
  const remaining = new Map(Object.entries(updates));
  const lines = [];

  for (const entry of entries) {
    if (entry.type === "pair" && remaining.has(entry.key)) {
      lines.push(`${entry.key}=${remaining.get(entry.key)}`);
      remaining.delete(entry.key);
    } else if (entry.type === "pair") {
      lines.push(`${entry.key}=${entry.value}`);
    } else {
      lines.push(entry.text);
    }
  }

  if (remaining.size > 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    lines.push("");
    if (appendHeading) {
      lines.push(`# ${appendHeading}`);
    }
    for (const [key, value] of remaining) {
      lines.push(`${key}=${value}`);
    }
    lines.push("");
  }

  fs.writeFileSync(filePath, lines.join("\n"), { mode: 0o600 });
  // writeFileSync only applies `mode` when creating a file, so tighten an
  // existing one explicitly: this file holds credentials.
  fs.chmodSync(filePath, 0o600);
  return readEnvFile(filePath);
}

/** True when a value is missing, blank, or still an obvious sample placeholder. */
function isPlaceholder(value) {
  if (value === undefined || value === null) {
    return true;
  }

  const trimmed = String(value).trim();
  if (trimmed === "" || PLACEHOLDER_VALUES.has(trimmed)) {
    return true;
  }

  return PLACEHOLDER_PREFIXES.some((prefix) => trimmed.toUpperCase().startsWith(prefix.toUpperCase()));
}

/** Mask a secret for display: never print a full token. */
function mask(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") {
    return "(empty)";
  }
  if (trimmed.length <= 8) {
    return `${"*".repeat(trimmed.length)} (${trimmed.length} chars)`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-2)} (${trimmed.length} chars)`;
}

module.exports = {
  ROOT,
  ENV_PATH,
  SAMPLE_ENV_PATH,
  parseEnvFile,
  readEnvFile,
  upsertEnvFile,
  isPlaceholder,
  mask,
};
