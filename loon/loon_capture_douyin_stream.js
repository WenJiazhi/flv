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

function writePersistent(key, value) {
  return $persistentStore.write(String(value), key);
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

function isIpHost(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(hostname || ""));
}

function isIpFlvUrl(urlValue) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized) {
    return false;
  }

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

function lockCapturedUrl(urlValue) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!isIpFlvUrl(sanitized)) {
    return false;
  }

  if (readPersistent(buildStorageKey("selected_location_url"), "")) {
    return false;
  }

  writePersistent(buildStorageKey("selected_location_url"), sanitized);
  writePersistent(buildStorageKey("selected_url"), sanitized);
  writePersistent(buildStorageKey("best_location_url"), sanitized);
  writePersistent(buildStorageKey("best_url"), sanitized);
  writePersistent(buildStorageKey("selected_at"), Date.now());
  return true;
}

const args = getArgumentObject();
const notifyCapture = String(args.notify_capture || "true").toLowerCase() !== "false";

let candidate = "";

if ($response && $response.headers) {
  const locationHeader = sanitizeUrlCandidate($response.headers.Location || $response.headers.location || "");
  if (isIpFlvUrl(locationHeader)) {
    candidate = locationHeader;
  }
}

if (!candidate && $request && $request.url && isIpFlvUrl($request.url)) {
  candidate = sanitizeUrlCandidate($request.url);
}

const lockedNow = lockCapturedUrl(candidate);
const selectedUrl = readPersistent(buildStorageKey("selected_location_url"), "");

if (notifyCapture && candidate) {
  const noticeText = selectedUrl || candidate;
  const noticeTitle = lockedNow ? "抓取成功" : "已命中已锁定流";
  $notification.post("Douyin Live Switch", noticeTitle, noticeText, {
    clipboard: noticeText,
  });
}

$done({});
