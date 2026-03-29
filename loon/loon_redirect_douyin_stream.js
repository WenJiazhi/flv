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

function isIpHost(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(hostname || ""));
}

function isSecondHopUrl(urlValue) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized) return false;
  try {
    const url = new URL(sanitized);
    return (url.protocol === "http:" || url.protocol === "https:") && isIpHost(url.hostname) && url.pathname.toLowerCase().endsWith(".flv");
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
const currentUrl = sanitizeUrlCandidate($request && $request.url ? $request.url : "");

if (!replacementUrl || !currentUrl || !isSecondHopUrl(currentUrl) || currentUrl === replacementUrl) {
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

  $notification.post("Douyin Live Switch", "第二跳兜底替换", replacementUrl, {
    clipboard: replacementUrl,
  });
  $done({
    url: replacementUrl,
    headers,
  });
}
