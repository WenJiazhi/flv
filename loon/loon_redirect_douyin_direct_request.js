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

function isDirectCdnFlvUrl(urlValue) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized) return false;
  try {
    const url = new URL(sanitized);
    return url.hostname.toLowerCase().includes("douyincdn.com") && url.pathname.toLowerCase().endsWith(".flv");
  } catch {
    return false;
  }
}

function getReplacementUrl(args) {
  return (
    sanitizeUrlCandidate(args.override_url || "") ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_location_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_url"), ""))
  );
}

const args = getArgumentObject();
const replacementUrl = getReplacementUrl(args);
const selectedMode = readPersistent(buildStorageKey("selected_mode"), "");
const currentUrl = sanitizeUrlCandidate($request && $request.url ? $request.url : "");

if (selectedMode !== "direct_200" || !replacementUrl || !currentUrl || !isDirectCdnFlvUrl(currentUrl) || currentUrl === replacementUrl) {
  $done({});
} else {
  $notification.post("Douyin Live Switch", "200 替换成功", replacementUrl, {
    clipboard: replacementUrl,
  });
  $done({
    url: replacementUrl,
    headers: Object.assign({}, $request.headers || {}),
  });
}
