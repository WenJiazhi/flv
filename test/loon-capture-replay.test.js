"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT_PATH = path.join(__dirname, "..", "loon", "loon_capture_douyin_stream.js");
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");
const TOGGLE_SCRIPT_PATH = path.join(__dirname, "..", "loon", "loon_capture_toggle_sync.js");
const TOGGLE_SCRIPT_SOURCE = fs.readFileSync(TOGGLE_SCRIPT_PATH, "utf8");
const PLUGIN_PATH = path.join(__dirname, "..", "loon", "douyin-live-switch.plugin");
const PLUGIN_SOURCE = fs.readFileSync(PLUGIN_PATH, "utf8");

function parseRawHeaders(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const startLine = lines.shift() || "";
  const headers = {};

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
  }

  return { startLine, headers };
}

function buildRequestFromDump(caseDir) {
  const requestText = fs.readFileSync(path.join(caseDir, "request_header_raw.txt"), "utf8");
  const { startLine, headers } = parseRawHeaders(requestText);
  const match = startLine.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/[\d.]+$/);
  assert.ok(match, `Unrecognized request line in ${caseDir}: ${startLine}`);
  const host = headers.Host || headers.host;
  assert.ok(host, `Missing host header in ${caseDir}`);

  return {
    method: match[1],
    url: `http://${host}${match[2]}`,
    headers,
  };
}

function buildResponseFromDump(caseDir) {
  const responseText = fs.readFileSync(path.join(caseDir, "response_header_raw.txt"), "utf8");
  const { startLine, headers } = parseRawHeaders(responseText);
  const match = startLine.match(/^HTTP\/[\d.]+\s+(\d{3}(?:\s+.*)?)$/);
  assert.ok(match, `Unrecognized response line in ${caseDir}: ${startLine}`);

  const bodyPathCandidates = [
    path.join(caseDir, "response_body_raw"),
    path.join(caseDir, "response_body_raw.txt"),
  ];
  const bodyPath = bodyPathCandidates.find((candidate) => fs.existsSync(candidate));

  return {
    status: match[1],
    headers,
    body: bodyPath ? fs.readFileSync(bodyPath, "utf8") : "",
  };
}

function runCaptureScript({ request, response, argument = "capture_enabled=true&notify_capture=false", store = {}, now = 1_700_000_000_000 }) {
  const notifications = [];
  let donePayload = null;
  const persistentState = { ...store };

  const sandbox = {
    URL,
    $request: request,
    $response: response,
    $argument: argument,
    $persistentStore: {
      read(key) {
        return Object.prototype.hasOwnProperty.call(persistentState, key) ? persistentState[key] : null;
      },
      write(value, key) {
        persistentState[key] = String(value);
        return true;
      },
    },
    $notification: {
      post(title, subtitle, body, extra) {
        notifications.push({ title, subtitle, body, extra });
      },
    },
    $done(payload) {
      donePayload = payload || {};
    },
    Date: {
      now() {
        return now;
      },
    },
  };

  vm.runInNewContext(`(() => {\n${SCRIPT_SOURCE}\n})();`, sandbox, { filename: SCRIPT_PATH });

  return {
    donePayload,
    notifications,
    store: persistentState,
  };
}

function runToggleScript({ argument = "capture_enabled=true", store = {} }) {
  const persistentState = { ...store };
  let donePayload = null;

  const sandbox = {
    $argument: argument,
    $persistentStore: {
      read(key) {
        return Object.prototype.hasOwnProperty.call(persistentState, key) ? persistentState[key] : null;
      },
      write(value, key) {
        persistentState[key] = String(value);
        return true;
      },
    },
    $done(payload) {
      donePayload = payload || {};
    },
  };

  vm.runInNewContext(`(() => {\n${TOGGLE_SCRIPT_SOURCE}\n})();`, sandbox, { filename: TOGGLE_SCRIPT_PATH });

  return {
    donePayload,
    store: persistentState,
  };
}

test("capture script recognizes douyinliving 302 redirect targets from real dumps", () => {
  const caseDir = path.join(__dirname, "..", "tmp_loon_dump8", "10440_11081_1774772982081");
  const result = runCaptureScript({
    request: buildRequestFromDump(caseDir),
    response: buildResponseFromDump(caseDir),
  });

  assert.equal(result.store["douyin-live-switch:selected_mode"], "redirect_302");
  assert.match(
    result.store["douyin-live-switch:selected_url"],
    /^http:\/\/36\.99\.3\.151\/fantasy\/stream-695562867764888407_sd5\.flv\?/,
  );
  assert.equal(result.store["douyin-live-switch:capture_lock"], "1");
});

test("capture script recognizes douyinliving dispatch json targets from real dumps", () => {
  const caseDir = path.join(__dirname, "..", "tmp_loon_dump8", "10637_11290_1774772991090");
  const result = runCaptureScript({
    request: buildRequestFromDump(caseDir),
    response: buildResponseFromDump(caseDir),
  });

  assert.equal(result.store["douyin-live-switch:selected_mode"], "dispatch_json");
  assert.match(
    result.store["douyin-live-switch:selected_url"],
    /^http:\/\/58\.218\.56\.161\/pull-f3\.douyinliving\.com\/fantasy\/stream-695562854007571287_sd5\.flv\?/,
  );
});

test("capture script recognizes direct 200 FLV requests", () => {
  const result = runCaptureScript({
    request: {
      method: "GET",
      url: "http://pull-flv-l1.douyincdn.com/third/stream-test.flv?unique_id=stream-test",
      headers: { Host: "pull-flv-l1.douyincdn.com" },
    },
    response: {
      status: "200 OK",
      headers: { "Content-Type": "video/x-flv" },
      body: "",
    },
  });

  assert.equal(result.store["douyin-live-switch:selected_mode"], "direct_200");
  assert.equal(
    result.store["douyin-live-switch:selected_url"],
    "http://pull-flv-l1.douyincdn.com/third/stream-test.flv?unique_id=stream-test",
  );
});

test("capture script accepts plugin object arguments from Loon", () => {
  const result = runCaptureScript({
    request: {
      method: "GET",
      url: "http://pull-flv-l1.douyincdn.com/third/stream-test.flv?unique_id=stream-test",
      headers: { Host: "pull-flv-l1.douyincdn.com" },
    },
    response: {
      status: "200 OK",
      headers: { "Content-Type": "video/x-flv" },
      body: "",
    },
    argument: {
      capture_enabled: true,
    },
  });

  assert.equal(result.store["douyin-live-switch:selected_mode"], "direct_200");
  assert.equal(
    result.store["douyin-live-switch:selected_url"],
    "http://pull-flv-l1.douyincdn.com/third/stream-test.flv?unique_id=stream-test",
  );
});

test("capture script clears lock and exits immediately when capture is disabled", () => {
  const result = runCaptureScript({
    request: {
      method: "GET",
      url: "http://pull-flv-l1.douyincdn.com/third/stream-test.flv?unique_id=stream-test",
      headers: { Host: "pull-flv-l1.douyincdn.com" },
    },
    response: {
      status: "302 Found",
      headers: { Location: "http://1.2.3.4/third/stream-test.flv?unique_id=stream-test" },
      body: "",
    },
    argument: "capture_enabled=false&notify_capture=false",
    store: {
      "douyin-live-switch:capture_lock": "1",
      "douyin-live-switch:capture_enabled_state": "1",
      "douyin-live-switch:selected_url": "http://old.example/stream.flv",
    },
  });

  assert.equal(result.store["douyin-live-switch:capture_lock"], "0");
  assert.equal(result.store["douyin-live-switch:capture_enabled_state"], "0");
  assert.equal(result.store["douyin-live-switch:selected_url"], "http://old.example/stream.flv");
  assert.deepEqual(result.notifications, []);
});

test("capture script still upgrades the same flow from direct 200 to redirect 302", () => {
  const result = runCaptureScript({
    request: {
      method: "GET",
      url: "http://pull-flv-l1.douyincdn.com/third/stream-upgrade.flv?unique_id=stream-upgrade",
      headers: { Host: "pull-flv-l1.douyincdn.com" },
    },
    response: {
      status: "302 Found",
      headers: { Location: "http://3.3.3.3/third/stream-upgrade.flv?unique_id=stream-upgrade" },
      body: "",
    },
    now: 2_000,
    store: {
      "douyin-live-switch:capture_lock": "1",
      "douyin-live-switch:capture_enabled_state": "1",
      "douyin-live-switch:selected_mode": "direct_200",
      "douyin-live-switch:selected_fingerprint": "stream-upgrade",
      "douyin-live-switch:selected_at": "1500",
      "douyin-live-switch:selected_url": "http://pull-flv-l1.douyincdn.com/third/stream-upgrade.flv?unique_id=stream-upgrade",
    },
  });

  assert.equal(result.store["douyin-live-switch:selected_mode"], "redirect_302");
  assert.equal(
    result.store["douyin-live-switch:selected_url"],
    "http://3.3.3.3/third/stream-upgrade.flv?unique_id=stream-upgrade",
  );
});

test("toggle sync resets the lock when capture is turned off and arms a fresh capture when turned on again", () => {
  const afterDisable = runToggleScript({
    argument: "capture_enabled=false",
    store: {
      "douyin-live-switch:capture_lock": "1",
      "douyin-live-switch:capture_enabled_state": "1",
      "douyin-live-switch:selected_url": "http://old.example/stream.flv",
    },
  });

  assert.equal(afterDisable.store["douyin-live-switch:capture_lock"], "0");
  assert.equal(afterDisable.store["douyin-live-switch:capture_enabled_state"], "0");
  assert.equal(afterDisable.store["douyin-live-switch:selected_url"], "http://old.example/stream.flv");

  const afterEnable = runToggleScript({
    argument: "capture_enabled=true",
    store: afterDisable.store,
  });

  assert.equal(afterEnable.store["douyin-live-switch:capture_lock"], "0");
  assert.equal(afterEnable.store["douyin-live-switch:capture_enabled_state"], "1");
});

test("toggle sync also accepts plugin object arguments from Loon", () => {
  const afterDisable = runToggleScript({
    argument: {
      capture_enabled: false,
    },
    store: {
      "douyin-live-switch:capture_lock": "1",
      "douyin-live-switch:capture_enabled_state": "1",
    },
  });

  assert.equal(afterDisable.store["douyin-live-switch:capture_lock"], "0");
  assert.equal(afterDisable.store["douyin-live-switch:capture_enabled_state"], "0");
});

test("capture script does not replace a locked flow with another new flow while capture stays enabled", () => {
  const result = runCaptureScript({
    request: {
      method: "GET",
      url: "http://pull-flv-l1.douyincdn.com/third/stream-new.flv?unique_id=stream-new",
      headers: { Host: "pull-flv-l1.douyincdn.com" },
    },
    response: {
      status: "302 Found",
      headers: { Location: "http://2.2.2.2/third/stream-new.flv?unique_id=stream-new" },
      body: "",
    },
    now: 10_000,
    store: {
      "douyin-live-switch:capture_lock": "1",
      "douyin-live-switch:capture_enabled_state": "1",
      "douyin-live-switch:selected_mode": "redirect_302",
      "douyin-live-switch:selected_fingerprint": "stream-old",
      "douyin-live-switch:selected_at": "1000",
      "douyin-live-switch:selected_url": "http://1.1.1.1/third/stream-old.flv?unique_id=stream-old",
    },
  });

  assert.equal(result.store["douyin-live-switch:selected_fingerprint"], "stream-old");
  assert.equal(result.store["douyin-live-switch:selected_url"], "http://1.1.1.1/third/stream-old.flv?unique_id=stream-old");
});

test("plugin uses Loon argument list syntax instead of inline key-value placeholders", () => {
  assert.match(PLUGIN_SOURCE, /argument=\[\{capture_enabled\}\]/);
  assert.match(PLUGIN_SOURCE, /argument=\[\{override_url\}\]/);
  assert.doesNotMatch(PLUGIN_SOURCE, /argument=.*capture_enabled=\{/);
  assert.doesNotMatch(PLUGIN_SOURCE, /argument=.*override_url=\{/);
});
