"use strict";

const MODE_PRIORITY = {
  direct_200: 1,
  dispatch_json: 2,
  redirect_302: 3,
};
const CAPTURE_LOCK_KEY = "capture_lock";
const CAPTURE_SWITCH_STATE_KEY = "capture_enabled_state";

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
    const hostname = url.hostname.toLowerCase();
    return (
      (hostname.includes("douyincdn.com") || hostname.includes("douyinliving.com")) &&
      url.pathname.toLowerCase().endsWith(".flv")
    );
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
        lowerPath.includes("/fantasy/") ||
        lowerSearch.includes("douyincdn.com") ||
        lowerSearch.includes("douyinliving.com") ||
        lowerSearch.includes("domain=") ||
        lowerSearch.includes("vhost=") ||
        lowerSearch.includes("fp_user_url=") ||
        lowerSearch.includes("redirect_to_ip=") ||
        lowerSearch.includes("302_dispatch=") ||
        lowerSearch.includes("ks302=")
      )
    );
  } catch {
    return false;
  }
}

function getModePriority(mode) {
  return MODE_PRIORITY[mode] || 0;
}

function getCaptureLock() {
  return readPersistent(buildStorageKey(CAPTURE_LOCK_KEY), "");
}

function setCaptureLock(value) {
  return writePersistent(value ? "1" : "0", buildStorageKey(CAPTURE_LOCK_KEY));
}

function getCaptureSwitchState() {
  return readPersistent(buildStorageKey(CAPTURE_SWITCH_STATE_KEY), "");
}

function setCaptureSwitchState(value) {
  return writePersistent(value ? "1" : "0", buildStorageKey(CAPTURE_SWITCH_STATE_KEY));
}

function getFlowFingerprint(urlValue) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized) return "";
  try {
    const url = new URL(sanitized);
    const uniqueId = url.searchParams.get("unique_id") || "";
    if (uniqueId) return uniqueId;
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length ? segments[segments.length - 1].toLowerCase() : sanitized;
  } catch {
    return sanitized;
  }
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

function storeCapturedUrl(urlValue, mode) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized || !mode) {
    return { stored: false, selected: "", mode: "" };
  }

  writePersistent(sanitized, buildStorageKey("selected_location_url"));
  writePersistent(sanitized, buildStorageKey("selected_url"));
  writePersistent(mode, buildStorageKey("selected_mode"));
  writePersistent(getFlowFingerprint(sanitized), buildStorageKey("selected_fingerprint"));
  writePersistent(String(Date.now()), buildStorageKey("selected_at"));

  return { stored: true, selected: sanitized, mode };
}

const args = getArgumentObject();
const captureEnabled = String(args.capture_enabled || "true").toLowerCase() === "true";
const notifyCapture = String(args.notify_capture || "true").toLowerCase() !== "false";

if (!captureEnabled) {
  setCaptureLock(false);
  setCaptureSwitchState(false);
  $done({});
  return;
}

if (getCaptureSwitchState() !== "1") {
  setCaptureLock(false);
  setCaptureSwitchState(true);
}

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

const candidateFingerprint = getFlowFingerprint(candidate);
const selectedFingerprint = readPersistent(buildStorageKey("selected_fingerprint"), "");
const selectedMode = readPersistent(buildStorageKey("selected_mode"), "");
const lockActive = getCaptureLock() === "1";
const allowUpgradeSameFlow =
  lockActive &&
  candidateFingerprint &&
  candidateFingerprint === selectedFingerprint &&
  getModePriority(mode) > getModePriority(selectedMode);

let finalResult = { stored: false, selected: "", mode: "" };

if (!lockActive || allowUpgradeSameFlow) {
  finalResult = storeCapturedUrl(candidate, mode);
  if (finalResult.stored) {
    setCaptureLock(true);
  }
}

if (notifyCapture && finalResult.stored) {
  const label =
    finalResult.mode === "redirect_302"
      ? "302 抓取成功"
      : finalResult.mode === "dispatch_json"
        ? "Dispatch 抓取成功"
        : "200 抓取成功";
  $notification.post("Douyin Live Switch", label, finalResult.selected, {
    clipboard: finalResult.selected,
  });
}

$done({});
