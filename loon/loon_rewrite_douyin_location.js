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

function shouldRewriteLocation(locationHeader) {
  const lower = String(locationHeader || "").toLowerCase();
  return lower.includes(".flv") && (lower.includes("pull-flv") || lower.includes("douyincdn.com"));
}

const args = getArgumentObject();
const replacementUrl = getReplacementUrl(args);

if (!$response || !$response.headers || !replacementUrl) {
  $done({});
} else {
  const headers = Object.assign({}, $response.headers);
  const locationHeader = headers.Location || headers.location || "";

  if (!shouldRewriteLocation(locationHeader)) {
    $done({});
  } else {
    headers.Location = replacementUrl;
    headers.location = replacementUrl;
    $notification.post("Douyin Live Switch", "302 替换成功", replacementUrl, {
      clipboard: replacementUrl,
    });
    $done({
      status: $response.status,
      headers,
    });
  }
}
