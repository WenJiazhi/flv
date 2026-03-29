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

function isLocationStyleUrl(urlValue) {
  const lower = String(urlValue || "").toLowerCase();
  return /^http:\/\/\d{1,3}(?:\.\d{1,3}){3}\//.test(lower) && lower.includes("pull-flv");
}

function getPreferredOverride(args) {
  const explicit = sanitizeUrlCandidate(args.override_url || "");
  if (isLocationStyleUrl(explicit)) {
    return explicit;
  }

  const useCaptured = String(args.use_captured || "").toLowerCase() !== "false";
  if (!useCaptured) {
    return explicit;
  }

  return (
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_location_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("best_location_url"), "")) ||
    explicit ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("best_url"), ""))
  );
}

function notifyReplacement(stage, replacementUrl) {
  $notification.post("Douyin Live Switch", `替换成功: ${stage}`, replacementUrl, {
    clipboard: replacementUrl,
  });
}

const args = getArgumentObject();
const replacementUrl = getPreferredOverride(args);

if (!$response || !$response.headers || !replacementUrl) {
  $done({});
} else {
  const headers = Object.assign({}, $response.headers);
  const locationHeader = headers.Location || headers.location || "";

  if (!locationHeader || !String(locationHeader).toLowerCase().includes(".flv")) {
    $done({});
  } else {
    headers.Location = replacementUrl;
    headers.location = replacementUrl;
    notifyReplacement("302 Location", replacementUrl);
    $done({
      status: $response.status,
      headers,
    });
  }
}
