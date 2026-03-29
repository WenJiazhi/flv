"use strict";

function getArgumentObject() {
  if (typeof $argument === "object" && $argument !== null) return $argument;
  if (typeof $argument !== "string" || !$argument.trim()) return {};
  return $argument
    .split("&")
    .map((item) => item.split("="))
    .reduce((result, pair) => {
      const key = decodeURIComponent(pair[0] || "").trim();
      if (!key) return result;
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
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return "";
  return trimmed;
}

function getReplacementUrl(args) {
  return (
    sanitizeUrlCandidate(args.override_url || "") ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_location_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_url"), ""))
  );
}

function shouldRewriteLocation(locationHeader) {
  const sanitized = sanitizeUrlCandidate(locationHeader);
  if (!sanitized) return false;
  const lower = sanitized.toLowerCase();
  return (
    lower.includes(".flv") &&
    (lower.includes("douyincdn.com") || lower.includes("douyinliving.com") || /^http:\/\/\d{1,3}(?:\.\d{1,3}){3}\//.test(lower))
  );
}

const args = getArgumentObject();
const replacementUrl = getReplacementUrl(args);
const selectedMode = readPersistent(buildStorageKey("selected_mode"), "");

if ((selectedMode !== "redirect_302" && selectedMode !== "dispatch_json") || !$response || !$response.headers || !replacementUrl) {
  $done({});
} else {
  const headers = Object.assign({}, $response.headers);
  const locationHeader = headers.Location || headers.location || "";
  if (!shouldRewriteLocation(locationHeader) || sanitizeUrlCandidate(locationHeader) === replacementUrl) {
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
