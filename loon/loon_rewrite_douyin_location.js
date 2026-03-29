"use strict";

function getArgumentObject() {
  if (typeof $argument === "object" && $argument !== null) {
    return $argument;
  }

  if (typeof $argument !== "string" || !$argument.trim()) {
    return {};
  }

  return $argument
    .split("&")
    .map((item) => item.split("="))
    .reduce((result, pair) => {
      const key = decodeURIComponent(pair[0] || "").trim();
      if (!key) {
        return result;
      }
      result[key] = decodeURIComponent(pair.slice(1).join("=") || "").trim();
      return result;
    }, {});
}

function readPersistent(key, fallback) {
  const value = $persistentStore.read(key);
  return value == null || value === "" ? fallback : value;
}

function buildStorageKey(name) {
  return `douyin-live-switch:${name}`;
}

function normalizeUrlCandidate(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    const firstSegment = (url.pathname.match(/^\/([^/]+)/) || [])[1] || "";
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(firstSegment)) {
      url.protocol = "https:";
      url.hostname = firstSegment;
      url.port = "";
      url.pathname = url.pathname.replace(/^\/[^/]+/, "") || "/";
    } else if (url.protocol === "http:" && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) {
      url.protocol = "https:";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function getPreferredOverride(args) {
  const explicit = normalizeUrlCandidate(args.override_url || "");
  if (explicit) {
    return explicit;
  }

  const useCaptured = String(args.use_captured || "").toLowerCase() !== "false";
  if (!useCaptured) {
    return "";
  }

  return normalizeUrlCandidate(readPersistent(buildStorageKey("best_url"), ""));
}

const args = getArgumentObject();
const replacementUrl = getPreferredOverride(args);

if (!$response || !$response.headers || !replacementUrl) {
  $done({});
} else {
  const headers = Object.assign({}, $response.headers);
  const locationHeader = headers.Location || headers.location || "";

  if (!locationHeader) {
    $done({});
  } else {
    headers.Location = replacementUrl;
    headers.location = replacementUrl;
    $done({
      status: $response.status,
      headers,
    });
  }
}
