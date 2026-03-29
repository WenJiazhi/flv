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

function isFlvUrl(urlValue) {
  const lower = String(urlValue || "").toLowerCase();
  return (
    lower.includes(".flv?") ||
    lower.endsWith(".flv") ||
    lower.includes("/pull-flv") ||
    lower.includes("pull-flv")
  );
}

function isLocationStyleUrl(urlValue) {
  const lower = String(urlValue || "").toLowerCase();
  return /^http:\/\/\d{1,3}(?:\.\d{1,3}){3}\//.test(lower) && lower.includes("pull-flv");
}

function shouldKeepFlv(urlValue, sourceKeyword) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!sanitized || !isFlvUrl(sanitized)) {
    return false;
  }

  if (!sourceKeyword) {
    return true;
  }

  return sanitized.toLowerCase().includes(String(sourceKeyword).toLowerCase());
}

function scoreEntry(entry) {
  let score = Number(entry.hits || 0) * 10 + String(entry.url || "").length;
  const url = String(entry.url || "").toLowerCase();

  if (isLocationStyleUrl(url)) {
    score += 1500;
  }
  if (url.includes("douyincdn.com")) {
    score += 1000;
  }
  if (url.includes(".flv")) {
    score += 800;
  }
  if (url.includes("pull-flv")) {
    score += 400;
  }

  return score;
}

function lockReplacementUrl(urlValue) {
  if (!isLocationStyleUrl(urlValue)) {
    return false;
  }

  const selectedLocationUrl = readPersistent(buildStorageKey("selected_location_url"), "");
  if (selectedLocationUrl) {
    return false;
  }

  writePersistent(buildStorageKey("selected_location_url"), urlValue);
  writePersistent(buildStorageKey("selected_url"), urlValue);
  writePersistent(buildStorageKey("selected_at"), Date.now());
  return true;
}

function rememberFlv(urlValue, source, sourceKeyword) {
  const sanitized = sanitizeUrlCandidate(urlValue);
  if (!shouldKeepFlv(sanitized, sourceKeyword)) {
    return null;
  }

  const entries = parseJson(readPersistent(buildStorageKey("captured_entries"), "[]"), []);
  const previousBest = readPersistent(buildStorageKey("best_url"), "");
  const previousLocation = readPersistent(buildStorageKey("best_location_url"), "");
  const now = Date.now();
  const existing = entries.find((item) => item.url === sanitized);
  let isNew = false;

  if (existing) {
    existing.hits = Number(existing.hits || 0) + 1;
    existing.seenAt = now;
    existing.sources = Array.isArray(existing.sources) ? existing.sources : [];
    if (source && !existing.sources.includes(source)) {
      existing.sources.push(source);
    }
  } else {
    isNew = true;
    entries.push({
      url: sanitized,
      hits: 1,
      seenAt: now,
      sources: source ? [source] : [],
    });
  }

  entries.sort((left, right) => scoreEntry(right) - scoreEntry(left));
  const trimmed = entries.slice(0, 12);
  writePersistent(buildStorageKey("captured_entries"), JSON.stringify(trimmed));

  const bestUrl = trimmed[0] ? trimmed[0].url : "";
  writePersistent(buildStorageKey("best_url"), bestUrl);

  let bestLocationUrl = previousLocation;
  if (isLocationStyleUrl(sanitized)) {
    bestLocationUrl = sanitized;
    writePersistent(buildStorageKey("best_location_url"), bestLocationUrl);
  }

  const lockedNow = lockReplacementUrl(sanitized);
  const selectedLocationUrl = readPersistent(buildStorageKey("selected_location_url"), "");

  return {
    url: sanitized,
    isNew,
    becameBest: Boolean(bestUrl) && bestUrl !== previousBest && bestUrl === sanitized,
    becameBestLocation:
      isLocationStyleUrl(sanitized) &&
      Boolean(bestLocationUrl) &&
      bestLocationUrl !== previousLocation,
    lockedNow,
    bestUrl,
    bestLocationUrl,
    selectedLocationUrl,
  };
}

function collectFlvCandidatesFromResponse(responseBody, sourceKeyword) {
  const candidates = [];

  if ($response && $response.headers) {
    const locationHeader = $response.headers.Location || $response.headers.location || "";
    if (locationHeader) {
      candidates.push({ url: locationHeader, source: `location:${$request.url}` });
    }
  }

  if ($request && $request.url && isLocationStyleUrl($request.url)) {
    candidates.push({ url: $request.url, source: `request:${$request.url}` });
  }

  if (typeof responseBody === "string" && responseBody) {
    for (const url of extractUrlsFromText(responseBody)) {
      if (isLocationStyleUrl(url)) {
        candidates.push({ url, source: `body:${$request.url}` });
      }
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

const args = getArgumentObject();
const sourceKeyword = String(args.source_keyword || "douyincdn.com").trim();
const notifyCapture = String(args.notify_capture || "true").toLowerCase() !== "false";
const body = $response && typeof $response.body === "string" ? $response.body : "";
const captured = collectFlvCandidatesFromResponse(body, sourceKeyword);

if (captured.length && notifyCapture) {
  const notable = captured.find((item) => item.lockedNow) || null;

  if (notable) {
    const text = notable.selectedLocationUrl || notable.url;
    $notification.post("Douyin Live Switch", "已锁定替换直播流", text, {
      clipboard: text,
    });
  }
}

$done({});
