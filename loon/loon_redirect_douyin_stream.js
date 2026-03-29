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

function sanitizeUrlCandidate(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return "";
  }

  return trimmed;
}

function shouldKeepFlv(urlValue) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized) {
    return false;
  }

  const lower = sanitized.toLowerCase();
  return (
    lower.includes(".flv?") ||
    lower.endsWith(".flv") ||
    lower.includes("/pull-flv") ||
    lower.includes("pull-flv")
  );
}

function getPreferredOverride(args) {
  const explicit = sanitizeUrlCandidate(args.override_url || "");
  if (explicit) {
    return explicit;
  }

  const useCaptured = String(args.use_captured || "").toLowerCase() !== "false";
  if (!useCaptured) {
    return "";
  }

  return (
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_location_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("best_location_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("best_url"), ""))
  );
}

function notifyReplacement(stage, replacementUrl) {
  $notification.post("Douyin Live Switch", `Replacement applied: ${stage}`, replacementUrl, {
    clipboard: replacementUrl,
  });
}

const args = getArgumentObject();
const replacementUrl = getPreferredOverride(args);

if (!replacementUrl || !shouldKeepFlv($request.url)) {
  $done({});
} else {
  const headers = Object.assign({}, $request.headers || {});
  try {
    const target = new URL(replacementUrl);
    headers.Host = target.host;
    headers.host = target.host;
  } catch {
    // Ignore parsing failures.
  }

  notifyReplacement("request redirect", replacementUrl);
  $done({
    url: replacementUrl,
    headers,
  });
}
