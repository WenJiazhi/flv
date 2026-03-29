"use strict";

const CAPTURE_DEDUPE_MS = 3000;

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
        lowerSearch.includes("redirect_to_ip=")
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

function storeCapturedUrl(urlValue, mode) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized || !mode) {
    return { stored: false, changed: false, selected: "", mode: "" };
  }

  const now = Date.now();
  const fingerprint = `${mode}|${fingerprintUrl(sanitized)}`;
  const previousFingerprint = readPersistent(buildStorageKey("selected_fingerprint"), "");
  const previousAt = Number(readPersistent(buildStorageKey("selected_at"), "0")) || 0;
  const isDuplicate = fingerprint && fingerprint === previousFingerprint && now - previousAt < CAPTURE_DEDUPE_MS;

  if (isDuplicate) {
    return { stored: false, changed: false, selected: sanitized, mode };
  }

  const previous = readPersistent(buildStorageKey("selected_location_url"), "");
  const previousMode = readPersistent(buildStorageKey("selected_mode"), "");
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

function isHttp200Response() {
  return Boolean($response && String($response.status || "").startsWith("200"));
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

if (!candidate && isHttp200Response() && isVideoFlvResponse() && $request && isDirectCdnFlvUrl($request.url || "")) {
  candidate = sanitizeUrlCandidate($request.url);
  mode = "direct_200";
}

const result = storeCapturedUrl(candidate, mode);

if (notifyCapture && result.stored) {
  const label = result.mode === "redirect_302" ? "302 抓取成功" : "200 抓取成功";
  $notification.post("Douyin Live Switch", label, result.selected, {
    clipboard: result.selected,
  });
}

$done({});
