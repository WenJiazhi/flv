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

function isIpFlvUrl(urlValue) {
  const lower = String(urlValue || "").toLowerCase();
  return /^http:\/\/\d{1,3}(?:\.\d{1,3}){3}\//.test(lower) && lower.includes("pull-flv") && lower.includes(".flv");
}

function getReplacementUrl(args) {
  const explicit = sanitizeUrlCandidate(args.override_url || "");
  if (explicit) {
    return explicit;
  }

  return (
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_location_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("best_location_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("best_url"), ""))
  );
}

const args = getArgumentObject();
const replacementUrl = getReplacementUrl(args);

if (!replacementUrl || !$request || !isIpFlvUrl($request.url)) {
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

  $notification.post("Douyin Live Switch", "第二跳替换成功", replacementUrl, {
    clipboard: replacementUrl,
  });
  $done({
    url: replacementUrl,
    headers,
  });
}
