/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseEnvFile, readEnvFile, upsertEnvFile, isPlaceholder, mask } = require("../scripts/lib/env");

function withTempEnvFile(contents, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jaspers-env-"));
  const filePath = path.join(directory, ".env");
  fs.writeFileSync(filePath, contents);
  try {
    return callback(filePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("parses keys while preserving comments and blank lines", () => {
  const entries = parseEnvFile("# heading\n\nACCESS_TOKEN=abc123\n# note\nPORT=8080\n");

  assert.deepEqual(
    entries.filter((entry) => entry.type === "pair"),
    [
      { type: "pair", key: "ACCESS_TOKEN", value: "abc123" },
      { type: "pair", key: "PORT", value: "8080" },
    ],
  );
  assert.equal(entries.filter((entry) => entry.type === "other").length, 4);
});

test("strips surrounding quotes from values", () => {
  const entries = parseEnvFile('A="quoted value"\nB=\'single\'\nC=plain\n');
  const values = Object.fromEntries(
    entries.filter((entry) => entry.type === "pair").map((entry) => [entry.key, entry.value]),
  );

  assert.deepEqual(values, { A: "quoted value", B: "single", C: "plain" });
});

test("reading a missing env file yields an empty map", () => {
  assert.deepEqual(readEnvFile(path.join(os.tmpdir(), "definitely-missing-jaspers.env")), {});
});

test("updates existing keys in place and preserves unrelated lines", () => {
  withTempEnvFile("# keep me\nPORT=8080\nWEBHOOK_CALLBACK_URL=https://old.example\n", (filePath) => {
    upsertEnvFile({ WEBHOOK_CALLBACK_URL: "https://new.example" }, { filePath });

    const contents = fs.readFileSync(filePath, "utf8");
    assert.match(contents, /# keep me/);
    assert.match(contents, /^PORT=8080$/m);
    assert.match(contents, /^WEBHOOK_CALLBACK_URL=https:\/\/new\.example$/m);
    assert.doesNotMatch(contents, /old\.example/);
  });
});

test("appends missing keys under an optional heading", () => {
  withTempEnvFile("PORT=8080\n", (filePath) => {
    upsertEnvFile({ WABA_ID: "123" }, { filePath, appendHeading: "Webhook tunnelling" });

    const contents = fs.readFileSync(filePath, "utf8");
    assert.match(contents, /^PORT=8080$/m);
    assert.match(contents, /^# Webhook tunnelling$/m);
    assert.match(contents, /^WABA_ID=123$/m);
  });
});

test("writes env files with owner-only permissions", () => {
  withTempEnvFile("PORT=8080\n", (filePath) => {
    upsertEnvFile({ WABA_ID: "123" }, { filePath });

    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test("detects blank, missing, and sample placeholder values", () => {
  for (const value of [undefined, null, "", "   ", "1234567890", "ADD_APP_TOKEN_HERE", "<APP_TOKEN>", "your_token"]) {
    assert.equal(isPlaceholder(value), true, `expected ${JSON.stringify(value)} to be a placeholder`);
  }

  for (const value of ["EAAG1234", "local-dev-placeholder-token", "abc"]) {
    assert.equal(isPlaceholder(value), false, `expected ${JSON.stringify(value)} to be real`);
  }
});

test("masks secrets without revealing them", () => {
  assert.equal(mask("EAAGabcdefghijklmnop"), "EAAG...op (20 chars)");
  assert.equal(mask("short"), "***** (5 chars)");
  assert.equal(mask(""), "(empty)");
  assert.doesNotMatch(mask("EAAGabcdefghijklmnop"), /abcdefghij/);
});
