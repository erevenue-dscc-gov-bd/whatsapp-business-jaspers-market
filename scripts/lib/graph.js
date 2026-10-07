/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

const API_BASE = "https://graph.facebook.com";

/**
 * Call the Graph API. The access token is only ever sent as an Authorization
 * header so it cannot leak into logs or error messages.
 */
async function graphRequest({
  version,
  path,
  method = "GET",
  token,
  query,
  body,
  timeoutMs = 15000,
}) {
  const url = new URL(`${API_BASE}/${version}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }

    return { ok: response.ok, status: response.status, json };
  } catch (error) {
    const cause = error.cause?.code || error.cause?.message;
    return {
      ok: false,
      status: 0,
      networkError:
        error.name === "AbortError"
          ? `timed out after ${timeoutMs}ms`
          : [error.message, cause].filter(Boolean).join(": "),
      json: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a human-readable message out of a Graph API error payload. */
function describeGraphError(result) {
  if (result.networkError) {
    return `network error: ${result.networkError}`;
  }
  const error = result.json?.error;
  if (error) {
    const parts = [error.message];
    if (error.code !== undefined) parts.push(`code ${error.code}`);
    if (error.error_subcode) parts.push(`subcode ${error.error_subcode}`);
    if (error.error_user_msg) parts.push(error.error_user_msg);
    return parts.filter(Boolean).join(" | ");
  }
  return `HTTP ${result.status}`;
}

module.exports = { API_BASE, graphRequest, describeGraphError };
