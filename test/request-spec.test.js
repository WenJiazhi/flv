"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSessionConfig } = require("../lib/request-spec");

test("buildSessionConfig resolves a relative URL from request line and host", () => {
  const result = buildSessionConfig({
    protocolHint: "https",
    rawHeaders: [
      "GET /live/test.flv?token=abc HTTP/1.1",
      "Host: demo.example.com",
      "Referer: https://demo.example.com/player",
      "User-Agent: TestAgent/1.0",
    ].join("\n"),
  });

  assert.equal(result.targetUrl, "https://demo.example.com/live/test.flv?token=abc");
  assert.equal(result.forwardHeaders["user-agent"], "TestAgent/1.0");
  assert.equal(result.forwardHeaders["accept-encoding"], "identity");
});

test("buildSessionConfig supports HTTP/2 pseudo headers", () => {
  const result = buildSessionConfig({
    rawHeaders: [
      ":method: GET",
      ":scheme: https",
      ":authority: live.example.com",
      ":path: /stream/live.flv?id=7",
      "Cookie: auth=abc",
    ].join("\n"),
  });

  assert.equal(result.targetUrl, "https://live.example.com/stream/live.flv?id=7");
  assert.equal(result.forwardHeaders.cookie, "auth=abc");
});

test("buildSessionConfig accepts an explicit URL when the raw headers do not include a path", () => {
  const result = buildSessionConfig({
    url: "https://cdn.example.com/live/main.flv",
    rawHeaders: ["Host: cdn.example.com", "Cookie: session=1"].join("\n"),
  });

  assert.equal(result.targetUrl, "https://cdn.example.com/live/main.flv");
  assert.equal(result.forwardHeaders.cookie, "session=1");
});

test("buildSessionConfig normalizes https IP edge URLs with an authority host embedded in the path", () => {
  const result = buildSessionConfig({
    rawHeaders: [
      "GET https://124.232.129.139/pull-flv-l1.douyincdn.com/third/stream.flv?token=1 HTTP/1.1",
      "Host: pull-flv-l1.douyincdn.com",
      "User-Agent: TestAgent/1.0",
    ].join("\n"),
  });

  assert.equal(
    result.targetUrl,
    "https://pull-flv-l1.douyincdn.com/third/stream.flv?token=1",
  );
});

test("buildSessionConfig normalizes https IP edge URLs using the first path segment when host is also an IP", () => {
  const result = buildSessionConfig({
    rawHeaders: [
      "GET https://60.163.129.137/pull-flv-l1.douyincdn.com/third/stream.flv?token=1 HTTP/1.1",
      "Host: 60.163.129.137",
      "User-Agent: TestAgent/1.0",
    ].join("\n"),
  });

  assert.equal(
    result.targetUrl,
    "https://pull-flv-l1.douyincdn.com/third/stream.flv?token=1",
  );
});
