"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");

const express = require("express");

const { buildSessionConfig } = require("./lib/request-spec");

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionStore = new Map();
const sessionTtlMs = 30 * 60 * 1000;
const browserFriendlyVideoCodecs = new Set(["h264", "avc1"]);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function touchSession(session) {
  session.lastAccessAt = Date.now();
}

function cleanupExpiredSessions() {
  const now = Date.now();

  for (const [id, session] of sessionStore.entries()) {
    if (now - session.lastAccessAt > sessionTtlMs) {
      sessionStore.delete(id);
    }
  }
}

function getSession(id) {
  return sessionStore.get(id);
}

function sendJsonError(res, status, message, extra = {}) {
  res.status(status).json({
    error: message,
    ...extra,
  });
}

function buildPlayUrls(id) {
  return {
    playUrl: `/live/${id}.flv`,
    directPlayUrl: `/live/${id}.flv`,
    transcodePlayUrl: `/live/${id}/transcode.flv`,
  };
}

function formatErrorMessage(error, fallbackMessage) {
  if (!(error instanceof Error)) {
    return fallbackMessage;
  }

  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const code = "code" in cause ? cause.code : "";
    const reason = "message" in cause ? cause.message : "";
    const detail = [code, reason].filter(Boolean).join(": ");
    if (detail) {
      return `${error.message}: ${detail}`;
    }
  }

  return error.message || fallbackMessage;
}

function buildFfmpegHeaderBlob(headers) {
  const lines = [];

  for (const [name, value] of Object.entries(headers)) {
    if (!value) {
      continue;
    }

    lines.push(`${name}: ${value}`);
  }

  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

function buildFfmpegArgs(session, outputTarget, extraOutputArgs = []) {
  const headerBlob = buildFfmpegHeaderBlob(session.forwardHeaders);
  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "+discardcorrupt+genpts",
    "-rw_timeout",
    "15000000",
  ];

  if (headerBlob) {
    ffmpegArgs.push("-headers", headerBlob);
  }

  ffmpegArgs.push(
    "-i",
    session.targetUrl,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "main",
    "-level",
    "4.1",
    "-g",
    "50",
    "-keyint_min",
    "50",
    "-sc_threshold",
    "0",
    "-max_muxing_queue_size",
    "1024",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-af",
    "aresample=async=1:first_pts=0",
    "-flush_packets",
    "1",
    ...extraOutputArgs,
    outputTarget,
  );

  return ffmpegArgs;
}

function spawnFfmpeg(session, outputTarget, extraOutputArgs = []) {
  return spawn("ffmpeg", buildFfmpegArgs(session, outputTarget, extraOutputArgs), {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function spawnFfprobe(session) {
  const headerBlob = buildFfmpegHeaderBlob(session.forwardHeaders);
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-rw_timeout",
    "15000000",
  ];

  if (headerBlob) {
    args.push("-headers", headerBlob);
  }

  args.push(session.targetUrl);

  return spawn("ffprobe", args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function proxyDirectStream(session, req, res) {
  const abortController = new AbortController();
  const abortUpstream = () => abortController.abort();
  req.on("close", abortUpstream);

  try {
    const upstream = await fetch(session.targetUrl, {
      method: "GET",
      headers: session.forwardHeaders,
      redirect: "follow",
      signal: abortController.signal,
    });

    if (!upstream.ok) {
      const bodyPreview = await upstream.text().catch(() => "");
      return sendJsonError(res, upstream.status, "上游直播地址返回了非成功状态码。", {
        status: upstream.status,
        bodyPreview: bodyPreview.slice(0, 400),
      });
    }

    if (!upstream.body) {
      return sendJsonError(res, 502, "上游响应没有可读取的数据流。");
    }

    const contentType = upstream.headers.get("content-type") || "video/x-flv";
    res.status(200);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("X-Proxy-Mode", "direct");

    const passthroughHeaders = [
      "pragma",
      "expires",
      "last-modified",
      "icy-name",
      "icy-br",
      "icy-description",
      "icy-genre",
    ];

    for (const headerName of passthroughHeaders) {
      const value = upstream.headers.get(headerName);
      if (value) {
        res.setHeader(headerName, value);
      }
    }

    Readable.fromWeb(upstream.body)
      .on("error", (error) => {
        res.destroy(error);
      })
      .pipe(res);
  } catch (error) {
    if (abortController.signal.aborted) {
      return;
    }

    if (!res.headersSent) {
      sendJsonError(res, 502, formatErrorMessage(error, "代理直播流失败。"));
      return;
    }

    res.destroy(error);
  }
}

function proxyTranscodedStream(session, req, res) {
  const ffmpeg = spawnFfmpeg(session, "pipe:1", ["-f", "flv"]);

  let stderrText = "";
  let firstChunkSeen = false;

  ffmpeg.on("error", (error) => {
    if (!res.headersSent) {
      sendJsonError(
        res,
        500,
        error.code === "ENOENT"
          ? "未找到 ffmpeg，可先安装 ffmpeg 后再使用转码模式。"
          : `启动 ffmpeg 失败：${error.message}`,
      );
      return;
    }

    res.destroy(error);
  });

  ffmpeg.stderr.on("data", (chunk) => {
    stderrText += chunk.toString();
    if (stderrText.length > 4000) {
      stderrText = stderrText.slice(-4000);
    }
  });

  ffmpeg.stdout.on("data", () => {
    if (firstChunkSeen) {
      return;
    }

    firstChunkSeen = true;
    if (!res.headersSent) {
      res.status(200);
      res.setHeader("Content-Type", "video/x-flv");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("X-Proxy-Mode", "transcode");
    }
  });

  ffmpeg.stdout.on("error", (error) => {
    res.destroy(error);
  });

  ffmpeg.stdout.pipe(res);

  const stopFfmpeg = () => {
    if (!ffmpeg.killed) {
      ffmpeg.kill("SIGKILL");
    }
  };

  req.on("close", stopFfmpeg);
  res.on("close", stopFfmpeg);

  ffmpeg.on("close", (code) => {
    req.off("close", stopFfmpeg);
    res.off("close", stopFfmpeg);

    if (code === 0 || res.destroyed) {
      return;
    }

    if (!res.headersSent) {
      sendJsonError(res, 502, "ffmpeg 转码失败。", {
        details: stderrText.trim().slice(-1200),
      });
      return;
    }

    res.destroy(new Error(`ffmpeg exited with code ${code}: ${stderrText.trim().slice(-300)}`));
  });
}

async function probeDirectStream(session, timeoutMs = 8000) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const upstream = await fetch(session.targetUrl, {
      method: "GET",
      headers: session.forwardHeaders,
      redirect: "follow",
      signal: abortController.signal,
    });

    if (!upstream.ok) {
      const bodyPreview = await upstream.text().catch(() => "");
      return {
        ok: false,
        mode: "direct",
        status: upstream.status,
        error: "上游直播地址返回了非成功状态码。",
        bodyPreview: bodyPreview.slice(0, 400),
      };
    }

    if (!upstream.body) {
      return {
        ok: false,
        mode: "direct",
        error: "上游响应没有可读取的数据流。",
      };
    }

    const reader = upstream.body.getReader();
    const firstChunk = await reader.read();
    await reader.cancel().catch(() => {});

    return {
      ok: !firstChunk.done && Boolean(firstChunk.value?.length),
      mode: "direct",
      contentType: upstream.headers.get("content-type") || "",
      firstBytes: firstChunk.value?.length || 0,
    };
  } catch (error) {
    return {
      ok: false,
      mode: "direct",
      error: formatErrorMessage(error, "直连探测失败。"),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function probeTranscodedStream(session, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const ffmpeg = spawnFfmpeg(session, "pipe:1", ["-t", "4", "-f", "flv"]);
    let settled = false;
    let stderrText = "";

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      if (!ffmpeg.killed) {
        ffmpeg.kill("SIGKILL");
      }
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      finish({
        ok: false,
        mode: "transcode",
        error: "转码预检超时，ffmpeg 在限定时间内没有输出首包。",
        details: stderrText.trim().slice(-1200),
      });
    }, timeoutMs);

    ffmpeg.on("error", (error) => {
      finish({
        ok: false,
        mode: "transcode",
        error:
          error.code === "ENOENT"
            ? "未找到 ffmpeg。"
            : `启动 ffmpeg 失败：${error.message}`,
      });
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderrText += chunk.toString();
      if (stderrText.length > 4000) {
        stderrText = stderrText.slice(-4000);
      }
    });

    ffmpeg.stdout.once("data", (chunk) => {
      finish({
        ok: true,
        mode: "transcode",
        firstBytes: chunk.length,
        details: stderrText.trim().slice(-800),
      });
    });

    ffmpeg.on("close", (code) => {
      if (settled) {
        return;
      }

      finish({
        ok: false,
        mode: "transcode",
        error: `ffmpeg 退出，代码 ${code}。`,
        details: stderrText.trim().slice(-1200),
      });
    });
  });
}

function analyzeSessionCodecs(session, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const ffprobe = spawnFfprobe(session);
    let settled = false;
    let stdoutText = "";
    let stderrText = "";

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      if (!ffprobe.killed) {
        ffprobe.kill("SIGKILL");
      }
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      finish({
        ok: false,
        error: "ffprobe 分析超时。",
        details: stderrText.trim().slice(-1200),
      });
    }, timeoutMs);

    ffprobe.on("error", (error) => {
      finish({
        ok: false,
        error:
          error.code === "ENOENT"
            ? "未找到 ffprobe。"
            : `启动 ffprobe 失败：${error.message}`,
      });
    });

    ffprobe.stdout.on("data", (chunk) => {
      stdoutText += chunk.toString();
      if (stdoutText.length > 20000) {
        stdoutText = stdoutText.slice(-20000);
      }
    });

    ffprobe.stderr.on("data", (chunk) => {
      stderrText += chunk.toString();
      if (stderrText.length > 4000) {
        stderrText = stderrText.slice(-4000);
      }
    });

    ffprobe.on("close", (code) => {
      if (settled) {
        return;
      }

      if (code !== 0) {
        finish({
          ok: false,
          error: `ffprobe 退出，代码 ${code}。`,
          details: stderrText.trim().slice(-1200),
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdoutText || "{}");
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const videoStream = streams.find((stream) => stream.codec_type === "video") || null;
        const audioStream = streams.find((stream) => stream.codec_type === "audio") || null;
        const videoCodec = String(videoStream?.codec_name || "").toLowerCase();
        const audioCodec = String(audioStream?.codec_name || "").toLowerCase();

        finish({
          ok: true,
          videoCodec,
          audioCodec,
          recommendedMode:
            videoCodec && browserFriendlyVideoCodecs.has(videoCodec) ? "direct" : "transcode",
        });
      } catch (error) {
        finish({
          ok: false,
          error: `解析 ffprobe 输出失败：${error.message}`,
          details: stdoutText.slice(-1200),
        });
      }
    });
  });
}

setInterval(cleanupExpiredSessions, 60 * 1000).unref();

app.post("/api/session", (req, res) => {
  try {
    const { rawHeaders = "", url = "", protocolHint = "https" } = req.body || {};
    const sessionConfig = buildSessionConfig({ rawHeaders, url, protocolHint });
    const id = crypto.randomUUID();
    const playUrls = buildPlayUrls(id);

    sessionStore.set(id, {
      ...sessionConfig,
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
    });

    res.json({
      id,
      ...playUrls,
      targetUrl: sessionConfig.targetUrl,
      forwardedHeaderNames: Object.keys(sessionConfig.forwardHeaders),
      availableModes: ["auto", "direct", "transcode"],
    });
  } catch (error) {
    sendJsonError(res, 400, error instanceof Error ? error.message : "无法解析请求头。");
  }
});

app.get("/api/session/:id", (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    return sendJsonError(res, 404, "播放会话不存在或已过期。");
  }

  touchSession(session);
  return res.json({
    id: req.params.id,
    ...buildPlayUrls(req.params.id),
    targetUrl: session.targetUrl,
    forwardedHeaderNames: Object.keys(session.forwardHeaders),
    createdAt: session.createdAt,
    lastAccessAt: session.lastAccessAt,
    availableModes: ["auto", "direct", "transcode"],
  });
});

app.get("/api/session/:id/probe", async (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    return sendJsonError(res, 404, "播放会话不存在或已过期。");
  }

  touchSession(session);

  const mode = String(req.query.mode || "direct").toLowerCase();

  if (mode === "transcode") {
    const result = await probeTranscodedStream(session);
    return res.status(result.ok ? 200 : 502).json(result);
  }

  const result = await probeDirectStream(session);
  return res.status(result.ok ? 200 : 502).json(result);
});

app.get("/api/session/:id/analyze", async (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    return sendJsonError(res, 404, "播放会话不存在或已过期。");
  }

  touchSession(session);
  const result = await analyzeSessionCodecs(session);
  return res.status(result.ok ? 200 : 502).json(result);
});

app.get("/live/:id.flv", async (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    return sendJsonError(res, 404, "播放会话不存在或已过期。");
  }

  touchSession(session);
  return proxyDirectStream(session, req, res);
});

app.get("/live/:id/transcode.flv", (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    return sendJsonError(res, 404, "播放会话不存在或已过期。");
  }

  touchSession(session);
  return proxyTranscodedStream(session, req, res);
});

app.listen(port, () => {
  console.log(`FLV player server is listening on http://localhost:${port}`);
});
