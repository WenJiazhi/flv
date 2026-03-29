// ==UserScript==
// @name         Douyin Live Stream Rewriter
// @namespace    https://local.codex/
// @version      0.2.0
// @description  Rewrite Douyin live stream URLs inside the real browser page and capture candidate stream URLs from page data.
// @author       Codex
// @match        *://live.douyin.com/*
// @match        *://www.douyin.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEYS = {
    enabled: "douyin-live-rewriter:enabled",
    replacementUrl: "douyin-live-rewriter:replacement-url",
    sourceKeyword: "douyin-live-rewriter:source-keyword",
    hostOverride: "douyin-live-rewriter:host-override",
  };

  const state = {
    enabled: readValue(STORAGE_KEYS.enabled, false),
    replacementUrl: readValue(STORAGE_KEYS.replacementUrl, ""),
    sourceKeyword: readValue(STORAGE_KEYS.sourceKeyword, "douyincdn.com"),
    hostOverride: readValue(STORAGE_KEYS.hostOverride, ""),
  };

  const capturedUrls = new Map();
  const panelListeners = new Set();
  const STREAM_KEY_HINTS = [
    "stream",
    "pull",
    "flv",
    "play",
    "url",
    "live",
    "cdn",
  ];

  function readValue(key, fallback) {
    try {
      const value = typeof GM_getValue === "function" ? GM_getValue(key, fallback) : fallback;
      return value == null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeValue(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
      }
    } catch {
      // Ignore userscript storage errors.
    }
  }

  function persistState() {
    writeValue(STORAGE_KEYS.enabled, state.enabled);
    writeValue(STORAGE_KEYS.replacementUrl, state.replacementUrl);
    writeValue(STORAGE_KEYS.sourceKeyword, state.sourceKeyword);
    writeValue(STORAGE_KEYS.hostOverride, state.hostOverride);
  }

  function log(message, extra) {
    const prefix = "[DouyinRewriter]";
    if (typeof extra === "undefined") {
      console.log(prefix, message);
    } else {
      console.log(prefix, message, extra);
    }
  }

  function notifyPanelListeners() {
    for (const listener of panelListeners) {
      try {
        listener();
      } catch {
        // Ignore UI refresh failures.
      }
    }
  }

  function normalizeUrlCandidate(value) {
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
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname || "");
  }

  function looksLikeDomain(value) {
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value || "");
  }

  function normalizeEdgeUrl(urlValue) {
    const normalizedCandidate = normalizeUrlCandidate(urlValue);
    if (!normalizedCandidate) {
      return "";
    }

    try {
      const url = new URL(normalizedCandidate);
      const firstSegment = (url.pathname.match(/^\/([^/]+)/) || [])[1] || "";

      if (isIpHost(url.hostname) && looksLikeDomain(firstSegment)) {
        url.protocol = "https:";
        url.hostname = firstSegment;
        url.port = "";
        url.pathname = url.pathname.replace(/^\/[^/]+/, "") || "/";
        return url.toString();
      }

      if (location.protocol === "https:" && url.protocol === "http:") {
        url.protocol = "https:";
        return url.toString();
      }

      return url.toString();
    } catch {
      return normalizedCandidate;
    }
  }

  function extractUrlsFromText(value) {
    if (typeof value !== "string" || !value) {
      return [];
    }

    const matches = value.match(/https?:\/\/[^\s"'\\<>()]+/g) || [];
    return matches.map((item) => item.trim());
  }

  function rememberCapturedUrl(urlValue, source) {
    const normalized = normalizeEdgeUrl(urlValue);
    if (!normalized) {
      return;
    }

    const existing = capturedUrls.get(normalized);
    if (existing) {
      existing.hits += 1;
      existing.seenAt = Date.now();
      if (source && !existing.sources.includes(source)) {
        existing.sources.push(source);
      }
      notifyPanelListeners();
      return;
    }

    capturedUrls.set(normalized, {
      url: normalized,
      hits: 1,
      seenAt: Date.now(),
      sources: source ? [source] : [],
    });
    log("captured stream candidate", { url: normalized, source });
    notifyPanelListeners();
  }

  function shouldInspectKey(key) {
    const normalizedKey = String(key || "").toLowerCase();
    return STREAM_KEY_HINTS.some((hint) => normalizedKey.includes(hint));
  }

  function shouldKeepCandidate(urlValue, source) {
    if (!urlValue) {
      return false;
    }

    const normalized = normalizeEdgeUrl(urlValue).toLowerCase();
    const sourceText = String(source || "").toLowerCase();
    const isFlvUrl =
      normalized.includes(".flv?") ||
      normalized.endsWith(".flv") ||
      normalized.includes("/pull-flv") ||
      normalized.includes("pull-flv");

    if (!isFlvUrl) {
      return false;
    }

    if (
      normalized.includes(".jpg") ||
      normalized.includes(".jpeg") ||
      normalized.includes(".png") ||
      normalized.includes(".webp") ||
      normalized.includes(".gif")
    ) {
      return false;
    }

    return (
      normalized.includes("douyincdn.com") ||
      sourceText.includes("flv") ||
      sourceText.includes("pull")
    );
  }

  function collectUrlsFromValue(value, source, seen = new WeakSet(), depth = 0) {
    if (!value) {
      return;
    }

    if (depth > 5) {
      return;
    }

    if (typeof value === "string") {
      for (const url of extractUrlsFromText(value)) {
        if (shouldKeepCandidate(url, source)) {
          rememberCapturedUrl(url, source);
        }
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (seen.has(value)) {
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        collectUrlsFromValue(item, source, seen, depth + 1);
      }
      return;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      if (depth > 0 && !shouldInspectKey(key)) {
        continue;
      }

      if (typeof nestedValue === "string") {
        for (const url of extractUrlsFromText(nestedValue)) {
          if (shouldKeepCandidate(url, `${source}:${key}`)) {
            rememberCapturedUrl(url, `${source}:${key}`);
          }
        }
      } else {
        collectUrlsFromValue(nestedValue, `${source}:${key}`, seen, depth + 1);
      }
    }
  }

  function canRewriteUrl(value) {
    const urlCandidate = normalizeUrlCandidate(value);
    if (!urlCandidate) {
      return false;
    }

    if (!state.enabled || !state.replacementUrl) {
      return false;
    }

    if (state.sourceKeyword && !urlCandidate.includes(state.sourceKeyword)) {
      return false;
    }

    return true;
  }

  function buildReplacementUrl(originalValue) {
    if (!canRewriteUrl(originalValue)) {
      return originalValue;
    }

    let replacement = normalizeEdgeUrl(state.replacementUrl.trim());
    const hostOverride = state.hostOverride.trim();

    if (hostOverride) {
      try {
        const replacementUrl = new URL(replacement);
        replacementUrl.host = hostOverride;
        replacement = replacementUrl.toString();
      } catch {
        // Ignore invalid host override values.
      }
    }

    return replacement;
  }

  function rewriteString(value) {
    if (typeof value !== "string") {
      return value;
    }

    for (const candidate of extractUrlsFromText(value)) {
      if (shouldKeepCandidate(candidate, "string-scan")) {
        rememberCapturedUrl(candidate, "string-scan");
      }
    }

    if (!state.enabled || !state.replacementUrl) {
      return value;
    }

    if (canRewriteUrl(value)) {
      const rewritten = buildReplacementUrl(value);
      if (rewritten !== value) {
        log("rewrote URL string", { from: value, to: rewritten });
      }
      return rewritten;
    }

    if (!state.sourceKeyword || !value.includes(state.sourceKeyword)) {
      return value;
    }

    return value.replace(/https?:\/\/[^\s"'\\<>()]+/g, (match) => {
      if (!canRewriteUrl(match)) {
        return match;
      }

      const rewritten = buildReplacementUrl(match);
      if (rewritten !== match) {
        log("rewrote embedded URL", { from: match, to: rewritten });
      }
      return rewritten;
    });
  }

  function rewriteDeep(value, seen = new WeakSet()) {
    collectUrlsFromValue(value, "object-scan");

    if (!state.enabled || !state.replacementUrl) {
      return value;
    }

    if (typeof value === "string") {
      return rewriteString(value);
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    if (seen.has(value)) {
      return value;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        value[index] = rewriteDeep(value[index], seen);
      }
      return value;
    }

    for (const key of Object.keys(value)) {
      try {
        value[key] = rewriteDeep(value[key], seen);
      } catch {
        // Ignore non-writable properties.
      }
    }

    return value;
  }

  function patchJsonParse() {
    const originalJsonParse = JSON.parse;
    JSON.parse = function patchedJsonParse(text, reviver) {
      const result = originalJsonParse.call(this, text, reviver);
      collectUrlsFromValue(result, "json-parse");
      return rewriteDeep(result);
    };
  }

  function patchFetch() {
    const originalFetch = window.fetch;
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch.call(this, input, init);

      try {
        const responseUrl =
          typeof input === "string"
            ? input
            : input && typeof input.url === "string"
              ? input.url
              : response.url;

        if (!responseUrl || !responseUrl.includes("douyin")) {
          return response;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!/json|javascript|text/i.test(contentType)) {
          return response;
        }

        const rawText = await response.clone().text();
        for (const candidate of extractUrlsFromText(rawText)) {
          rememberCapturedUrl(candidate, `fetch:${responseUrl}`);
        }

        const rewrittenText = rewriteString(rawText);
        if (rewrittenText === rawText) {
          return response;
        }

        log("rewrote fetch response body", responseUrl);
        return new Response(rewrittenText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        log("fetch rewrite failed", error);
        return response;
      }
    };
  }

  function patchXhr() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__douyinRewriterUrl = typeof url === "string" ? url : "";
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body) {
      this.addEventListener("readystatechange", () => {
        if (this.readyState !== 4) {
          return;
        }

        try {
          const responseUrl = this.responseURL || this.__douyinRewriterUrl || "";
          if (!responseUrl.includes("douyin")) {
            return;
          }

          const contentType = this.getResponseHeader("content-type") || "";
          if (!/json|javascript|text/i.test(contentType)) {
            return;
          }

          const responseText = this.responseText;
          for (const candidate of extractUrlsFromText(responseText)) {
            rememberCapturedUrl(candidate, `xhr:${responseUrl}`);
          }

          const rewrittenText = rewriteString(responseText);
          if (rewrittenText === responseText) {
            return;
          }

          Object.defineProperty(this, "responseText", {
            configurable: true,
            value: rewrittenText,
          });
          Object.defineProperty(this, "response", {
            configurable: true,
            value: rewrittenText,
          });
          log("rewrote XHR response body", responseUrl);
        } catch (error) {
          log("XHR rewrite failed", error);
        }
      });

      return originalSend.call(this, body);
    };
  }

  function patchAssigners() {
    const targetKeys = [
      "streamData",
      "stream_data",
      "stream_url",
      "streamUrl",
      "pull_data",
      "pullData",
      "flv_pull_url",
      "flvPullUrl",
      "liveCoreSDKData",
      "__INITIAL_STATE__",
      "__NEXT_DATA__",
      "RENDER_DATA",
    ];

    for (const key of targetKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(window, key);
      if (descriptor && !descriptor.configurable) {
        continue;
      }

      let internalValue = window[key];

      Object.defineProperty(window, key, {
        configurable: true,
        enumerable: true,
        get() {
          return internalValue;
        },
        set(nextValue) {
          collectUrlsFromValue(nextValue, `window.${key}`);
          internalValue = rewriteDeep(nextValue);
          log(`patched window.${key}`);
        },
      });
    }
  }

  function patchHistory() {
    const originalPushState = history.pushState;
    history.pushState = function patchedPushState(...args) {
      const result = originalPushState.apply(this, args);
      window.dispatchEvent(new Event("douyin-rewriter:navigation"));
      return result;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      window.dispatchEvent(new Event("douyin-rewriter:navigation"));
      return result;
    };
  }

  function getCapturedEntries() {
    return Array.from(capturedUrls.values()).sort((left, right) => right.seenAt - left.seenAt);
  }

  function scoreCapturedEntry(entry) {
    let score = entry.hits * 10 + entry.url.length;

    if (entry.url.includes("douyincdn.com")) {
      score += 1000;
    }
    if (entry.url.includes(".flv")) {
      score += 600;
    }
    if (entry.url.includes("pull-")) {
      score += 300;
    }
    if (entry.sources.some((item) => item.startsWith("fetch:"))) {
      score += 120;
    }
    if (entry.sources.some((item) => item.startsWith("xhr:"))) {
      score += 100;
    }
    if (entry.sources.some((item) => item.includes("stream"))) {
      score += 80;
    }

    return score;
  }

  function getBestCapturedEntry() {
    const entries = getCapturedEntries();
    if (!entries.length) {
      return null;
    }

    return entries.sort((left, right) => scoreCapturedEntry(right) - scoreCapturedEntry(left))[0];
  }

  function scanCurrentPage() {
    const scriptNodes = document.querySelectorAll("script");
    for (const node of scriptNodes) {
      if (!node.textContent) {
        continue;
      }
      for (const candidate of extractUrlsFromText(node.textContent)) {
        if (shouldKeepCandidate(candidate, "manual-script-scan")) {
          rememberCapturedUrl(candidate, "manual-script-scan");
        }
      }
    }

    return getCapturedEntries();
  }

  function createOverlay() {
    const root = document.createElement("div");
    root.id = "douyin-live-rewriter-root";
    root.innerHTML = `
      <style>
        #douyin-live-rewriter-root {
          position: fixed;
          top: 16px;
          right: 16px;
          z-index: 2147483647;
          width: 360px;
          color: #f9efe1;
          font: 13px/1.5 "Segoe UI", "PingFang SC", sans-serif;
        }
        #douyin-live-rewriter-root .panel {
          background: rgba(16, 12, 10, 0.92);
          border: 1px solid rgba(255, 204, 153, 0.18);
          border-radius: 16px;
          box-shadow: 0 18px 44px rgba(0, 0, 0, 0.28);
          overflow: hidden;
        }
        #douyin-live-rewriter-root .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 14px;
          background: linear-gradient(135deg, rgba(224, 99, 36, 0.94), rgba(138, 52, 18, 0.94));
        }
        #douyin-live-rewriter-root .header strong {
          font-size: 14px;
        }
        #douyin-live-rewriter-root .body {
          display: grid;
          gap: 10px;
          padding: 12px 14px 14px;
        }
        #douyin-live-rewriter-root label {
          display: grid;
          gap: 5px;
        }
        #douyin-live-rewriter-root input,
        #douyin-live-rewriter-root textarea,
        #douyin-live-rewriter-root button {
          font: inherit;
        }
        #douyin-live-rewriter-root input,
        #douyin-live-rewriter-root textarea {
          width: 100%;
          color: #fff5eb;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 214, 179, 0.14);
          border-radius: 10px;
          padding: 9px 10px;
          outline: none;
        }
        #douyin-live-rewriter-root textarea {
          min-height: 86px;
          resize: vertical;
        }
        #douyin-live-rewriter-root .row {
          display: flex;
          gap: 8px;
        }
        #douyin-live-rewriter-root button {
          border: 0;
          border-radius: 999px;
          padding: 8px 12px;
          cursor: pointer;
        }
        #douyin-live-rewriter-root .primary {
          background: #f58f55;
          color: #200f08;
          font-weight: 700;
        }
        #douyin-live-rewriter-root .ghost {
          background: rgba(255, 255, 255, 0.08);
          color: #f6dcc6;
        }
        #douyin-live-rewriter-root .status {
          color: #ffc997;
          white-space: pre-wrap;
          word-break: break-all;
        }
        #douyin-live-rewriter-root .captured {
          display: grid;
          gap: 8px;
          max-height: 260px;
          overflow: auto;
        }
        #douyin-live-rewriter-root .captured-item {
          display: grid;
          gap: 6px;
          padding: 9px 10px;
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 214, 179, 0.1);
        }
        #douyin-live-rewriter-root .captured-item code {
          color: #ffe8cf;
          white-space: pre-wrap;
          word-break: break-all;
        }
        #douyin-live-rewriter-root .captured-meta {
          color: #d4b292;
          font-size: 12px;
        }
        #douyin-live-rewriter-root .captured-actions {
          display: flex;
          gap: 8px;
        }
      </style>
      <div class="panel">
        <div class="header">
          <strong>Douyin Rewriter</strong>
          <label><input id="dlr-enabled" type="checkbox" /> 启用</label>
        </div>
        <div class="body">
          <label>
            <span>替换流地址</span>
            <textarea id="dlr-replacement" placeholder="https://..."></textarea>
          </label>
          <div class="status" id="dlr-hint"></div>
          <label>
            <span>命中过滤关键字</span>
            <input id="dlr-keyword" placeholder="douyincdn.com" />
          </label>
          <div class="status">当前抓取策略: 只保留 FLV 直播流，不再显示图片或其他资源 URL。</div>
          <label>
            <span>可选 Host 覆盖</span>
            <input id="dlr-host" placeholder="pull-flv-l1.douyincdn.com" />
          </label>
          <div class="row">
            <button id="dlr-save" class="primary" type="button">保存并刷新</button>
            <button id="dlr-disable" class="ghost" type="button">关闭重写</button>
          </div>
          <div class="row">
            <button id="dlr-scan" class="ghost" type="button">抓取当前页链接</button>
            <button id="dlr-copy" class="ghost" type="button">复制当前替换流</button>
          </div>
          <div class="status">已抓到的候选流链接</div>
          <div class="captured" id="dlr-captured"></div>
          <div class="status" id="dlr-status"></div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);

    const enabledInput = root.querySelector("#dlr-enabled");
    const replacementInput = root.querySelector("#dlr-replacement");
    const keywordInput = root.querySelector("#dlr-keyword");
    const hostInput = root.querySelector("#dlr-host");
    const saveButton = root.querySelector("#dlr-save");
    const disableButton = root.querySelector("#dlr-disable");
    const scanButton = root.querySelector("#dlr-scan");
    const copyButton = root.querySelector("#dlr-copy");
    const status = root.querySelector("#dlr-status");
    const hint = root.querySelector("#dlr-hint");
    const capturedContainer = root.querySelector("#dlr-captured");

    function renderCaptured() {
      const bestEntry = getBestCapturedEntry();
      capturedContainer.innerHTML = "";

      if (!bestEntry) {
        capturedContainer.textContent = "暂时还没抓到链接。先等页面加载，或点“抓取当前页链接”。";
        return;
      }

      const item = document.createElement("div");
      item.className = "captured-item";

      const code = document.createElement("code");
      code.textContent = bestEntry.url;

      const meta = document.createElement("div");
      meta.className = "captured-meta";
      meta.textContent = `最佳候选 | 命中 ${bestEntry.hits} 次 | 来源 ${bestEntry.sources.slice(0, 3).join(", ") || "unknown"}`;

      const actions = document.createElement("div");
      actions.className = "captured-actions";

      const useButton = document.createElement("button");
      useButton.type = "button";
      useButton.className = "primary";
      useButton.textContent = "用这个";
      useButton.addEventListener("click", () => {
        state.replacementUrl = bestEntry.url;
        replacementInput.value = bestEntry.url;
        persistState();
        renderStatus();
      });

      const copyItemButton = document.createElement("button");
      copyItemButton.type = "button";
      copyItemButton.className = "ghost";
      copyItemButton.textContent = "复制";
      copyItemButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(bestEntry.url);
          hint.textContent = "已复制候选链接。";
        } catch {
          hint.textContent = "复制失败，浏览器可能不允许脚本访问剪贴板。";
        }
      });

      actions.append(useButton, copyItemButton);
      item.append(code, meta, actions);
      capturedContainer.appendChild(item);
    }

    function renderStatus() {
      const normalizedReplacement = normalizeEdgeUrl(state.replacementUrl);
      status.textContent = [
        `状态: ${state.enabled ? "启用" : "关闭"}`,
        normalizedReplacement ? `替换流: ${normalizedReplacement}` : "替换流: 未设置",
        state.sourceKeyword ? `过滤关键字: ${state.sourceKeyword}` : "过滤关键字: 全部 FLV URL",
      ].join("\n");

      if (!state.replacementUrl) {
        hint.textContent = "提示: 直播页是 HTTPS，替换流也必须可按 HTTPS 请求。";
      } else {
        const rawReplacement = state.replacementUrl.trim();
        const normalized = normalizeEdgeUrl(rawReplacement);
        if (rawReplacement !== normalized) {
          hint.textContent = `已自动规范化为: ${normalized}`;
        } else {
          hint.textContent = "提示: 如果填的是 IP 直链，脚本会自动尝试改成 https://真实域名/... 形式。";
        }
      }

      renderCaptured();
    }

    enabledInput.checked = state.enabled;
    replacementInput.value = state.replacementUrl;
    keywordInput.value = state.sourceKeyword;
    hostInput.value = state.hostOverride;

    saveButton.addEventListener("click", () => {
      state.enabled = enabledInput.checked;
      state.replacementUrl = normalizeEdgeUrl(replacementInput.value.trim());
      state.sourceKeyword = keywordInput.value.trim();
      state.hostOverride = hostInput.value.trim();
      persistState();
      replacementInput.value = state.replacementUrl;
      renderStatus();
      location.reload();
    });

    disableButton.addEventListener("click", () => {
      state.enabled = false;
      enabledInput.checked = false;
      persistState();
      renderStatus();
    });

    scanButton.addEventListener("click", () => {
      scanCurrentPage();
      renderCaptured();
      hint.textContent = "已重新抓取当前页里的候选链接。";
    });

    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(replacementInput.value.trim());
        hint.textContent = "已复制当前替换流地址。";
      } catch {
        hint.textContent = "复制失败，浏览器可能不允许脚本访问剪贴板。";
      }
    });

    panelListeners.add(renderCaptured);
    renderStatus();
  }

  function bootstrapOverlay() {
    const start = () => {
      if (!document.body || document.getElementById("douyin-live-rewriter-root")) {
        return;
      }
      createOverlay();
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  patchJsonParse();
  patchFetch();
  patchXhr();
  patchAssigners();
  patchHistory();
  bootstrapOverlay();

  window.__DOUYIN_REWRITER__ = {
    getCapturedUrls() {
      return getCapturedEntries();
    },
    collectNow() {
      return scanCurrentPage();
    },
    setReplacementUrl(urlValue) {
      state.replacementUrl = normalizeEdgeUrl(urlValue);
      persistState();
      notifyPanelListeners();
      return state.replacementUrl;
    },
  };

  log("userscript initialized", {
    enabled: state.enabled,
    replacementUrl: state.replacementUrl,
    sourceKeyword: state.sourceKeyword,
  });
})();
