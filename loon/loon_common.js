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
      const value = decodeURIComponent(pair.slice(1).join("=") || "").trim();
      result[key] = value;
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

function isIpHost(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname || "");
}

function looksLikeDomain(value) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value || "");
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

    if (isIpHost(url.hostname) && looksLikeDomain(firstSegment)) {
      url.protocol = "https:";
      url.hostname = firstSegment;
      url.port = "";
      url.pathname = url.pathname.replace(/^\/[^/]+/, "") || "/";
      return url.toString();
    }

    if (url.protocol === "http:" && !isIpHost(url.hostname)) {
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
  return matches
    .map((item) => normalizeUrlCandidate(item))
    .filter(Boolean);
}

function isFlvUrl(urlValue) {
  const value = String(urlValue || "").toLowerCase();
  return (
    value.includes(".flv?") ||
    value.endsWith(".flv") ||
    value.includes("/pull-flv") ||
    value.includes("pull-flv")
  );
}

function shouldKeepFlv(urlValue, sourceKeyword) {
  const normalized = normalizeUrlCandidate(urlValue);
  if (!normalized || !isFlvUrl(normalized)) {
    return false;
  }

  if (!sourceKeyword) {
    return true;
  }

  return normalized.toLowerCase().includes(String(sourceKeyword).toLowerCase());
}

function buildStorageKey(name) {
  return `douyin-live-switch:${name}`;
}

function readCapturedEntries() {
  return parseJson(readPersistent(buildStorageKey("captured_entries"), "[]"), []);
}

function writeCapturedEntries(entries) {
  writePersistent(buildStorageKey("captured_entries"), JSON.stringify(entries));
}

function scoreEntry(entry) {
  let score = Number(entry.hits || 0) * 10 + String(entry.url || "").length;
  const url = String(entry.url || "").toLowerCase();
  const sources = Array.isArray(entry.sources) ? entry.sources : [];

  if (url.includes("douyincdn.com")) {
    score += 1000;
  }
  if (url.includes(".flv")) {
    score += 800;
  }
  if (url.includes("pull-flv")) {
    score += 400;
  }
  if (sources.some((item) => String(item).startsWith("location:"))) {
    score += 150;
  }
  if (sources.some((item) => String(item).startsWith("request:"))) {
    score += 120;
  }

  return score;
}

function rememberFlv(urlValue, source, sourceKeyword) {
  const normalized = normalizeUrlCandidate(urlValue);
  if (!shouldKeepFlv(normalized, sourceKeyword)) {
    return null;
  }

  const entries = readCapturedEntries();
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
  writeCapturedEntries(trimmed);
  writePersistent(buildStorageKey("best_url"), trimmed[0] ? trimmed[0].url : "");

  return normalized;
}

function getPreferredOverride(argumentObject) {
  const explicit = normalizeUrlCandidate(argumentObject.override_url || "");
  if (explicit) {
    return explicit;
  }

  const useCaptured = String(argumentObject.use_captured || "").toLowerCase() !== "false";
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

function collectFlvCandidatesFromResponse(request, responseBody, sourceKeyword) {
  const candidates = [];

  if ($request && $request.url) {
    candidates.push({ url: $request.url, source: `request:${$request.url}` });
  }

  const locationHeader =
    $response &&
    $response.headers &&
    ($response.headers.Location || $response.headers.location || "");
  if (locationHeader) {
    candidates.push({ url: locationHeader, source: `location:${$request.url}` });
  }

  if (typeof responseBody === "string" && responseBody) {
    for (const url of extractUrlsFromText(responseBody)) {
      candidates.push({ url, source: `body:${$request.url}` });
    }
  }

  const captured = [];
  for (const item of candidates) {
    const remembered = rememberFlv(item.url, item.source, sourceKeyword);
    if (remembered) {
      captured.push(remembered);
    }
  }

  return captured;
}

globalThis.LoonDouyinCommon = {
  buildStorageKey,
  collectFlvCandidatesFromResponse,
  getArgumentObject,
  getPreferredOverride,
  normalizeUrlCandidate,
  parseJson,
  readCapturedEntries,
  readPersistent,
  rememberFlv,
  replaceFlvUrlsInText,
  shouldKeepFlv,
  writePersistent,
};
