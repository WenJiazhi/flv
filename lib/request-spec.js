"use strict";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function mergeHeaderValue(existingValue, nextValue, name) {
  if (!existingValue) {
    return nextValue;
  }

  if (name === "cookie") {
    return `${existingValue}; ${nextValue}`;
  }

  return `${existingValue}, ${nextValue}`;
}

function parseRawRequest(rawText = "") {
  const lines = String(rawText).replace(/\r\n?/g, "\n").split("\n");
  let requestLine = "";
  const headers = {};
  const pseudoHeaders = {};

  for (const originalLine of lines) {
    const line = originalLine.trimEnd();

    if (!line.trim()) {
      continue;
    }

    if (!requestLine && /^[A-Z]+\s+\S+\s+HTTP\/\d(?:\.\d)?$/i.test(line.trim())) {
      requestLine = line.trim();
      continue;
    }

    const pseudoMatch = line.match(/^(:[A-Za-z0-9-]+)\s*:\s*(.*)$/);
    if (pseudoMatch) {
      const name = pseudoMatch[1].toLowerCase();
      const value = pseudoMatch[2].trim();
      if (value) {
        pseudoHeaders[name] = mergeHeaderValue(pseudoHeaders[name], value, name);
      }
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (!name || !value) {
      continue;
    }

    headers[name] = mergeHeaderValue(headers[name], value, name);
  }

  return { requestLine, headers, pseudoHeaders };
}

function extractRequestTarget(requestLine = "") {
  const match = String(requestLine)
    .trim()
    .match(/^([A-Z]+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/i);

  if (!match) {
    return { method: "GET", target: "" };
  }

  return {
    method: match[1].toUpperCase(),
    target: match[2],
  };
}

function inferScheme({ explicitUrl = "", protocolHint = "https", pseudoHeaders, headers }) {
  if (/^https?:\/\//i.test(explicitUrl)) {
    return new URL(explicitUrl).protocol.replace(":", "");
  }

  if (pseudoHeaders[":scheme"]) {
    return pseudoHeaders[":scheme"].toLowerCase();
  }

  const refererLike = headers.referer || headers.origin;
  if (refererLike) {
    try {
      return new URL(refererLike).protocol.replace(":", "");
    } catch {
      // Ignore malformed referer/origin values and fall back to the hint.
    }
  }

  return String(protocolHint).toLowerCase() === "http" ? "http" : "https";
}

function isIpAddress(hostname = "") {
  if (!hostname) {
    return false;
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return true;
  }

  return hostname.includes(":");
}

function splitHostAndPort(hostValue = "") {
  const trimmed = String(hostValue).trim();

  if (!trimmed) {
    return { hostname: "", port: "" };
  }

  if (trimmed.startsWith("[")) {
    const bracketIndex = trimmed.indexOf("]");
    if (bracketIndex >= 0) {
      const hostname = trimmed.slice(1, bracketIndex);
      const port = trimmed.slice(bracketIndex + 2);
      return { hostname, port };
    }
  }

  const lastColonIndex = trimmed.lastIndexOf(":");
  if (lastColonIndex > 0 && trimmed.indexOf(":") === lastColonIndex) {
    return {
      hostname: trimmed.slice(0, lastColonIndex),
      port: trimmed.slice(lastColonIndex + 1),
    };
  }

  return { hostname: trimmed, port: "" };
}

function looksLikeDomainName(value = "") {
  if (!value || isIpAddress(value)) {
    return false;
  }

  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value);
}

function normalizeTlsEdgeUrl(targetUrl, headers, pseudoHeaders) {
  const url = new URL(targetUrl);
  const authority = headers.host || pseudoHeaders[":authority"] || "";
  const { hostname: authorityHost, port: authorityPort } = splitHostAndPort(authority);
  const [, firstPathSegment = ""] = url.pathname.match(/^\/([^/]+)/) || [];
  const pathDomain = looksLikeDomainName(firstPathSegment) ? firstPathSegment : "";
  const resolvedHost = !isIpAddress(authorityHost) && authorityHost ? authorityHost : pathDomain;

  if (url.protocol !== "https:" || !isIpAddress(url.hostname) || !resolvedHost) {
    return url.toString();
  }

  const encodedResolvedHost = resolvedHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pathPattern = new RegExp(`^/${encodedResolvedHost}(?=/|$)`, "i");

  if (!pathPattern.test(url.pathname)) {
    return url.toString();
  }

  url.hostname = resolvedHost;
  if (authorityPort && !pathDomain) {
    url.port = authorityPort;
  } else {
    url.port = "";
  }
  url.pathname = url.pathname.replace(pathPattern, "") || "/";

  return url.toString();
}

function resolveTargetUrl({ explicitUrl = "", protocolHint = "https", requestLine, headers, pseudoHeaders }) {
  if (explicitUrl) {
    return new URL(explicitUrl).toString();
  }

  const { target } = extractRequestTarget(requestLine);
  const rawTarget = target || pseudoHeaders[":path"] || "";

  if (!rawTarget) {
    throw new Error("未解析到播放地址。请填写播放地址，或粘贴包含请求行/伪头的完整请求头。");
  }

  if (/^https?:\/\//i.test(rawTarget)) {
    return normalizeTlsEdgeUrl(new URL(rawTarget).toString(), headers, pseudoHeaders);
  }

  const host = headers.host || pseudoHeaders[":authority"];
  if (!host) {
    throw new Error("请求头中缺少 Host/:authority，无法拼接直播地址。");
  }

  const scheme = inferScheme({ explicitUrl, protocolHint, pseudoHeaders, headers });
  return normalizeTlsEdgeUrl(new URL(rawTarget, `${scheme}://${host}`).toString(), headers, pseudoHeaders);
}

function sanitizeForwardHeaders(headers, pseudoHeaders) {
  const cleanedHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name)) {
      continue;
    }

    cleanedHeaders[name] = value;
  }

  if (pseudoHeaders[":authority"] && !cleanedHeaders.host) {
    cleanedHeaders.host = pseudoHeaders[":authority"];
  }

  cleanedHeaders["accept-encoding"] = "identity";

  return cleanedHeaders;
}

function buildSessionConfig({ rawHeaders = "", url = "", protocolHint = "https" }) {
  const parsed = parseRawRequest(rawHeaders);
  const { method } = extractRequestTarget(parsed.requestLine);
  const targetUrl = resolveTargetUrl({
    explicitUrl: url,
    protocolHint,
    requestLine: parsed.requestLine,
    headers: parsed.headers,
    pseudoHeaders: parsed.pseudoHeaders,
  });

  if (method !== "GET") {
    throw new Error(`当前只支持 GET 流播放，解析到的方法是 ${method}。`);
  }

  return {
    targetUrl,
    forwardHeaders: sanitizeForwardHeaders(parsed.headers, parsed.pseudoHeaders),
    parsed,
  };
}

module.exports = {
  buildSessionConfig,
  extractRequestTarget,
  looksLikeDomainName,
  normalizeTlsEdgeUrl,
  parseRawRequest,
  resolveTargetUrl,
  sanitizeForwardHeaders,
  splitHostAndPort,
};
