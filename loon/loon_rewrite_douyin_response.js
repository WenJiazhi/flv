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

function normalizeUrlCandidate(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    const firstSegment = (url.pathname.match(/^\/([^/]+)/) || [])[1] || "";
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(firstSegment)) {
      url.protocol = "https:";
      url.hostname = firstSegment;
      url.port = "";
      url.pathname = url.pathname.replace(/^\/[^/]+/, "") || "/";
    } else if (url.protocol === "http:" && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) {
      url.protocol = "https:";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function extractUrlsFromText(value) {
  if (typeof value !== "string" || !value) {
    return [];
  }

  const matches = value.match(/https?:\/\/[^\s"'\\<>()]+/g) || [];
  return matches.map((item) => normalizeUrlCandidate(item)).filter(Boolean);
}

function shouldKeepFlv(urlValue, sourceKeyword) {
  const normalized = normalizeUrlCandidate(urlValue);
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
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
  if (url.includes("douyincdn.com")) score += 1000;
  if (url.includes(".flv")) score += 800;
  if (url.includes("pull-flv")) score += 400;
  return score;
}

function rememberFlv(urlValue, source, sourceKeyword) {
  const normalized = normalizeUrlCandidate(urlValue);
  if (!shouldKeepFlv(normalized, sourceKeyword)) {
    return null;
  }

  const entries = parseJson(readPersistent(buildStorageKey("captured_entries"), "[]"), []);
  const now = Date.now();
  const existing = entries.find((item) => item.url === normalized);

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
  writePersistent(buildStorageKey("captured_entries"), JSON.stringify(trimmed));
  writePersistent(buildStorageKey("best_url"), trimmed[0] ? trimmed[0].url : "");
  return normalized;
}

function getPreferredOverride(args) {
  const explicit = normalizeUrlCandidate(args.override_url || "");
  if (explicit) {
    return explicit;
  }

  const useCaptured = String(args.use_captured || "").toLowerCase() !== "false";
  if (!useCaptured) {
    return "";
  }

  return normalizeUrlCandidate(readPersistent(buildStorageKey("best_url"), ""));
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
