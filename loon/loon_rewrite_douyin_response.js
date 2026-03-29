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

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
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

function extractUrlsFromText(value) {
  if (typeof value !== "string" || !value) {
    return [];
  }

  const matches = value.match(/https?:\/\/[^\s"'\\<>()]+/g) || [];
  return matches.map((item) => sanitizeUrlCandidate(item)).filter(Boolean);
}

function isLocationStyleUrl(urlValue) {
  const lower = String(urlValue || "").toLowerCase();
  return /^http:\/\/\d{1,3}(?:\.\d{1,3}){3}\//.test(lower) && lower.includes("pull-flv");
}

function shouldKeepFlv(urlValue, sourceKeyword) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized) {
    return false;
  }

  const lower = sanitized.toLowerCase();
  const isFlv =
    lower.includes(".flv?") ||
    lower.endsWith(".flv") ||
    lower.includes("/pull-flv") ||
    lower.includes("pull-flv");

  if (!isFlv) {
    return false;
  }

  if (!sourceKeyword) {
    return true;
  }

  return lower.includes(String(sourceKeyword).toLowerCase());
}

function scoreEntry(entry) {
  let score = Number(entry.hits || 0) * 10 + String(entry.url || "").length;
  const url = String(entry.url || "").toLowerCase();
  if (isLocationStyleUrl(url)) score += 1500;
  if (url.includes("douyincdn.com")) score += 1000;
  if (url.includes(".flv")) score += 800;
  if (url.includes("pull-flv")) score += 400;
  return score;
}

function rememberFlv(urlValue, source, sourceKeyword) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!shouldKeepFlv(sanitized, sourceKeyword)) {
    return null;
  }

  const entries = parseJson(readPersistent(buildStorageKey("captured_entries"), "[]"), []);
  const now = Date.now();
  const existing = entries.find((item) => item.url === sanitized);

  if (existing) {
    existing.hits = Number(existing.hits || 0) + 1;
    existing.seenAt = now;
    existing.sources = Array.isArray(existing.sources) ? existing.sources : [];
    if (source && !existing.sources.includes(source)) {
      existing.sources.push(source);
    }
  } else {
    entries.push({
      url: normalized,
      hits: 1,
      seenAt: now,
      sources: source ? [source] : [],
    });
  }

  entries.sort((left, right) => scoreEntry(right) - scoreEntry(left));
  const trimmed = entries.slice(0, 12);
  $persistentStore.write(JSON.stringify(trimmed), buildStorageKey("captured_entries"));
  $persistentStore.write(trimmed[0] ? trimmed[0].url : "", buildStorageKey("best_url"));

  if (isLocationStyleUrl(sanitized)) {
    $persistentStore.write(sanitized, buildStorageKey("best_location_url"));
  }

  return sanitized;
}

function getPreferredOverride(args) {
  const explicit = sanitizeUrlCandidate(args.override_url || "");
  const useCaptured = String(args.use_captured || "").toLowerCase() !== "false";

  if (isLocationStyleUrl(explicit)) {
    return explicit;
  }

  if (!useCaptured) {
    return explicit;
  }

  return (
    sanitizeUrlCandidate(readPersistent(buildStorageKey("best_location_url"), "")) ||
    explicit ||
    sanitizeUrlCandidate(readPersistent(buildStorageKey("best_url"), ""))
  );
}

function replaceFlvUrlsInText(text, replacementUrl, sourceKeyword) {
  if (typeof text !== "string" || !text || !replacementUrl) {
    return text;
  }

  return text.replace(/https?:\/\/[^\s"'\\<>()]+/g, (candidate) => {
    if (!shouldKeepFlv(candidate, sourceKeyword)) {
      return candidate;
    }
    return replacementUrl;
  });
}

const args = getArgumentObject();
const sourceKeyword = String(args.source_keyword || "douyincdn.com").trim();
const replacementUrl = getPreferredOverride(args);

if (!$response || typeof $response.body !== "string" || !$response.body) {
  $done({});
} else {
  for (const url of extractUrlsFromText($response.body)) {
    rememberFlv(url, `body:${$request.url}`, sourceKeyword);
  }

  if (!replacementUrl) {
    $done({});
  } else {
    const newBody = replaceFlvUrlsInText($response.body, replacementUrl, sourceKeyword);
    if (newBody === $response.body) {
      $done({});
    } else {
      const headers = Object.assign({}, $response.headers || {});
      delete headers["Content-Length"];
      delete headers["content-length"];
      $done({
        status: $response.status,
        headers,
        body: newBody,
      });
    }
  }
}
