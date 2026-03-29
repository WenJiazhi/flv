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

function isIpHost(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(hostname || ""));
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

function isJsonResponse() {
  if (!$response || !$response.headers) return false;
  const contentType = String($response.headers["Content-Type"] || $response.headers["content-type"] || "").toLowerCase();
  return contentType.includes("application/json");
}

function getReplacementUrl(args) {
  return (
    sanitizeUrlCandidate(args.override_url || "") ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_location_url"), "")) ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("selected_url"), ""))
  );
}

function rewriteDispatchNode(node, replacementUrl) {
  if (!node || typeof node !== "object") return false;

  let changed = false;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (rewriteDispatchNode(item, replacementUrl)) changed = true;
    }
    return changed;
  }

  if (typeof node.complete_url === "string" && isRedirectTargetFlvUrl(node.complete_url)) {
    node.complete_url = replacementUrl;
    try {
      const target = new URL(replacementUrl);
      node.ip = target.hostname;
      node.port = target.port || (target.protocol === "https:" ? "443" : "80");
      node.redirect = true;
    } catch {
      // ignore
    }
    changed = true;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object" && rewriteDispatchNode(value, replacementUrl)) {
      changed = true;
    }
  }

  return changed;
}

const args = getArgumentObject();
const replacementUrl = getReplacementUrl(args);
const selectedMode = readPersistent(buildStorageKey("selected_mode"), "");

if (!replacementUrl || !$response || !isJsonResponse() || (selectedMode !== "redirect_302" && selectedMode !== "dispatch_json")) {
  $done({});
} else {
  let parsed = null;
  try {
    parsed = JSON.parse($response.body || "");
  } catch {
    parsed = null;
  }

  if (!parsed || !rewriteDispatchNode(parsed, replacementUrl)) {
    $done({});
  } else {
    $notification.post("Douyin Live Switch", "Dispatch 替换成功", replacementUrl, {
      clipboard: replacementUrl,
    });
    $done({
      status: $response.status,
      headers: Object.assign({}, $response.headers || {}),
      body: JSON.stringify(parsed),
    });
  }
}
