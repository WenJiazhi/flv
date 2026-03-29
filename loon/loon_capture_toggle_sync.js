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

function writePersistent(key, value) {
  return $persistentStore.write(String(value), key);
}

function readPersistent(key, fallback) {
  const value = $persistentStore.read(key);
  return value == null || value === "" ? fallback : value;
}

function buildStorageKey(name) {
  return `douyin-live-switch:${name}`;
}

const args = getArgumentObject();
const captureEnabled = String(args.capture_enabled || "true").toLowerCase() === "true";
const switchStateKey = buildStorageKey("capture_enabled_state");
const lockKey = buildStorageKey("capture_lock");
const previousState = readPersistent(switchStateKey, "0");

if (!captureEnabled) {
  writePersistent(lockKey, "0");
  writePersistent(switchStateKey, "0");
} else {
  if (previousState !== "1") {
    writePersistent(lockKey, "0");
  }
  writePersistent(switchStateKey, "1");
}

$done({});
