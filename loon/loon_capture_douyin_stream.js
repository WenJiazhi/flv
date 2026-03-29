"use strict";

const CAPTURE_DEDUPE_MS = 3000;
const MODE_PRIORITY = {
  direct_200: 1,
  dispatch_json: 2,
  redirect_302: 3,
};

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

function writePersistent(key, value) {
  return $persistentStore.write(String(value), key);
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

function isRedirectTargetFlvUrl(urlValue) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized) return false;
  try {
    const url = new URL(sanitized);
    const lowerPath = url.pathname.toLowerCase();
    const lowerSearch = url.search.toLowerCase();
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isIpHost(url.hostname) &&
      lowerPath.endsWith(".flv") &&
      (
        lowerPath.includes("pull-flv") ||
        lowerPath.includes("/third/") ||
        lowerPath.includes("/stage/") ||
        lowerPath.includes("/thirdgame/") ||
        lowerSearch.includes("douyincdn.com") ||
        lowerSearch.includes("domain=") ||
        lowerSearch.includes("vhost=") ||
        lowerSearch.includes("fp_user_url=") ||
        lowerSearch.includes("redirect_to_ip=") ||
        lowerSearch.includes("302_dispatch=")
      )
    );
  } catch {
    return false;
  }
}

function fingerprintUrl(urlValue) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized) return "";
  try {
    const url = new URL(sanitized);
    const uniqueId = url.searchParams.get("unique_id") || "";
    return [url.hostname, url.pathname, uniqueId].join("|");
  } catch {
    return sanitized;
  }
}

function getModePriority(mode) {
  return MODE_PRIORITY[mode] || 0;
}

function storeCapturedUrl(urlValue, mode) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized || !mode) {
    return { stored: false, changed: false, selected: "", mode: "" };
  }

  const now = Date.now();
  const fingerprint = fingerprintUrl(sanitized);
  const previousFingerprint = readPersistent(buildStorageKey("selected_fingerprint"), "");
  const previousAt = Number(readPersistent(buildStorageKey("selected_at"), "0")) || 0;
  const previousMode = readPersistent(buildStorageKey("selected_mode"), "");
  const withinWindow = fingerprint && fingerprint === previousFingerprint && now - previousAt < CAPTURE_DEDUPE_MS;

  if (withinWindow && getModePriority(mode) <= getModePriority(previousMode)) {
    return { stored: false, changed: false, selected: sanitized, mode };
  }

  const previous = readPersistent(buildStorageKey("selected_location_url"), "");
  const changed = previous !== sanitized || previousMode !== mode;

  writePersistent(buildStorageKey("selected_location_url"), sanitized);
  writePersistent(buildStorageKey("selected_url"), sanitized);
  writePersistent(buildStorageKey("selected_mode"), mode);
  writePersistent(buildStorageKey("selected_fingerprint"), fingerprint);
  writePersistent(buildStorageKey("selected_at"), now);

  return { stored: true, changed, selected: sanitized, mode };
}

function isVideoFlvResponse() {
  if (!$response || !$response.headers) return false;
  const contentType = String($response.headers["Content-Type"] || $response.headers["content-type"] || "").toLowerCase();
  return contentType.includes("video/x-flv");
}

function isJsonResponse() {
  if (!$response || !$response.headers) return false;
  const contentType = String($response.headers["Content-Type"] || $response.headers["content-type"] || "").toLowerCase();
  return contentType.includes("application/json");
}

function isHttp200Response() {
  return Boolean($response && String($response.status || "").startsWith("200"));
}

function tryParseJsonBody() {
  if (!$response || typeof $response.body !== "string" || !$response.body) return null;
  try {
    return JSON.parse($response.body);
  } catch {
    return null;
  }
}

function extractDispatchCompleteUrl(node) {
  if (!node || typeof node !== "object") return "";

  if (typeof node.complete_url === "string" && isRedirectTargetFlvUrl(node.complete_url)) {
    return sanitizeUrlCandidate(node.complete_url);
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const candidate = extractDispatchCompleteUrl(item);
      if (candidate) return candidate;
    }
    return "";
  }

  for (const value of Object.values(node)) {
    const candidate = extractDispatchCompleteUrl(value);
    if (candidate) return candidate;
  }

  return "";
}

const args = getArgumentObject();
const notifyCapture = String(args.notify_capture || "true").toLowerCase() !== "false";

let candidate = "";
let mode = "";

if ($response && $response.headers) {
  const locationHeader = sanitizeUrlCandidate($response.headers.Location || $response.headers.location || "");
  if (isRedirectTargetFlvUrl(locationHeader)) {
    candidate = locationHeader;
    mode = "redirect_302";
  }
}

if (!candidate && isHttp200Response() && isJsonResponse()) {
  const dispatchUrl = extractDispatchCompleteUrl(tryParseJsonBody());
  if (dispatchUrl) {
    candidate = dispatchUrl;
    mode = "dispatch_json";
  }
}

if (!candidate && isHttp200Response() && isVideoFlvResponse() && $request && isDirectCdnFlvUrl($request.url || "")) {
  candidate = sanitizeUrlCandidate($request.url);
  mode = "direct_200";
}

const result = storeCapturedUrl(candidate, mode);

if (notifyCapture && result.stored) {
  const label =
    result.mode === "redirect_302"
      ? "302 抓取成功"
      : result.mode === "dispatch_json"
        ? "Dispatch 抓取成功"
        : "200 抓取成功";
  $notification.post("Douyin Live Switch", label, result.selected, {
    clipboard: result.selected,
  });
}

$done({});
