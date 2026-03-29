"use strict";

const form = document.querySelector("#player-form");
const video = document.querySelector("#video");
const statusText = document.querySelector("#statusText");
const resolvedUrl = document.querySelector("#resolvedUrl");
const rawHeadersInput = document.querySelector("#rawHeaders");
const fillDemoBtn = document.querySelector("#fillDemoBtn");
const stopBtn = document.querySelector("#stopBtn");
const clearLogBtn = document.querySelector("#clearLogBtn");
const logElement = document.querySelector("#log");
const modeInput = document.querySelector("#mode");

let player = null;
let currentSession = null;
let currentMode = "auto";
let autoFallbackUsed = false;
let startupWatchdog = null;
let resolvedStartupMode = "direct";
let playerGeneration = 0;

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logElement.textContent = `[${timestamp}] ${message}\n${logElement.textContent}`.trim();
}

function setStatus(message, url = "") {
  statusText.textContent = message;
  resolvedUrl.textContent = url || "尚未创建播放会话";
}

function destroyPlayer() {
  if (startupWatchdog) {
    window.clearTimeout(startupWatchdog);
    startupWatchdog = null;
  }

  if (player) {
    try {
      const stalePlayer = player;
      player = null;
      window.setTimeout(() => {
        try {
          stalePlayer.pause();
          stalePlayer.unload();
          stalePlayer.detachMediaElement();
          stalePlayer.destroy();
        } catch (error) {
          appendLog(`销毁播放器时出现异常: ${error.message}`);
        }
      }, 80);
    } catch (error) {
      appendLog(`销毁播放器时出现异常: ${error.message}`);
    }
  }

  video.removeAttribute("src");
  video.load();
}

async function probeSession(sessionId, mode) {
  const response = await fetch(
    `/api/session/${encodeURIComponent(sessionId)}/probe?mode=${encodeURIComponent(mode)}`,
  );
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.details ? `${result.error} ${result.details}` : result.error);
  }

  return result;
}

async function analyzeSession(sessionId) {
  const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}/analyze`);
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.details ? `${result.error} ${result.details}` : result.error);
  }

  return result;
}

function getPlayUrl(session, mode) {
  if (mode === "transcode") {
    return session.transcodePlayUrl;
  }

  return session.directPlayUrl || session.playUrl;
}

function getModeLabel(mode) {
  if (mode === "transcode") {
    return "转码兼容模式";
  }

  if (mode === "direct") {
    return "直连模式";
  }

  return "自动模式";
}

async function resolveStartupMode(session) {
  if (currentMode === "direct") {
    appendLog(`开始进行${getModeLabel("direct")}预检。`);
    const directProbe = await probeSession(session.id, "direct");
    appendLog(`直连模式预检成功: 首包 ${directProbe.firstBytes || 0} 字节`);
    return "direct";
  }

  if (currentMode === "transcode") {
    appendLog(`开始进行${getModeLabel("transcode")}预检。`);
    const transcodeProbe = await probeSession(session.id, "transcode");
    appendLog(`转码兼容模式预检成功: 首包 ${transcodeProbe.firstBytes || 0} 字节`);
    return "transcode";
  }

  appendLog("开始分析源流编码。");

  try {
    const analysis = await analyzeSession(session.id);
    appendLog(
      `源流编码分析: video=${analysis.videoCodec || "unknown"}, audio=${analysis.audioCodec || "unknown"}`,
    );

    if (analysis.recommendedMode === "transcode") {
      appendLog("自动模式判定该源流不适合浏览器直播，直接切换到转码兼容模式。");
      const transcodeProbe = await probeSession(session.id, "transcode");
      appendLog(`转码兼容模式预检成功: 首包 ${transcodeProbe.firstBytes || 0} 字节`);
      autoFallbackUsed = true;
      return "transcode";
    }
  } catch (error) {
    appendLog(`源流编码分析失败，回退到直连优先策略: ${error.message}`);
  }

  appendLog("开始进行直连模式预检。");

  try {
    const directProbe = await probeSession(session.id, "direct");
    appendLog(`直连模式预检成功: 首包 ${directProbe.firstBytes || 0} 字节`);
    return "direct";
  } catch (error) {
    appendLog(`直连模式预检失败，准备尝试转码兼容模式: ${error.message}`);
  }

  appendLog("开始进行转码兼容模式预检。");
  const transcodeProbe = await probeSession(session.id, "transcode");
  appendLog(`转码兼容模式预检成功: 首包 ${transcodeProbe.firstBytes || 0} 字节`);
  autoFallbackUsed = true;
  return "transcode";
}

function handleCodecFallback(errorType, errorDetail, errorInfo) {
  const detailText = String(errorDetail || "").toLowerCase();
  const infoText = JSON.stringify(errorInfo || {}).toLowerCase();
  const isCodecUnsupported =
    detailText.includes("codecunsupported") ||
    detailText.includes("codec") ||
    infoText.includes("unsupported codec");

  if (!isCodecUnsupported || currentMode !== "auto" || autoFallbackUsed || !currentSession) {
    return false;
  }

  autoFallbackUsed = true;
  appendLog("检测到浏览器不支持当前 FLV 编码，自动切换到 ffmpeg 转码兼容模式。");
  setStatus("转码兼容播放中", currentSession.targetUrl);

  window.setTimeout(() => {
    try {
      createPlayer(currentSession, "transcode");
    } catch (error) {
      setStatus(`转码模式启动失败: ${error.message}`, currentSession.targetUrl);
      appendLog(`转码模式启动失败: ${error.message}`);
    }
  }, 0);

  return true;
}

function createPlayer(session, mode) {
  if (!window.flvjs || !window.flvjs.isSupported()) {
    throw new Error("当前浏览器不支持 flv.js 播放。");
  }

  destroyPlayer();
  playerGeneration += 1;
  const generation = playerGeneration;

  const playUrl = getPlayUrl(session, mode);
  const modeLabel = getModeLabel(mode);

  player = window.flvjs.createPlayer(
    {
      type: "flv",
      url: playUrl,
      isLive: true,
    },
    {
      enableWorker: false,
      stashInitialSize: 128,
      lazyLoad: false,
      deferLoadAfterSourceOpen: false,
    },
  );

  player.attachMediaElement(video);
  player.load();
  player.play().catch((error) => {
    if (generation !== playerGeneration) {
      return;
    }
    appendLog(`浏览器拦截自动播放: ${error.message}`);
  });

  startupWatchdog = window.setTimeout(() => {
    appendLog("播放器在 12 秒内没有进入 playing，可能是上游流没有首包、ffmpeg 没有出流，或浏览器还未收到可解码数据。");
  }, 12000);

  player.on(window.flvjs.Events.ERROR, (errorType, errorDetail, errorInfo) => {
    if (generation !== playerGeneration) {
      return;
    }

    appendLog(
      `播放器错误: ${errorType} / ${errorDetail} / ${JSON.stringify(errorInfo || {})}`,
    );

    if (handleCodecFallback(errorType, errorDetail, errorInfo)) {
      return;
    }
  });

  player.on(window.flvjs.Events.LOADING_COMPLETE, () => {
    if (generation !== playerGeneration) {
      return;
    }
    appendLog("流加载完成。");
  });

  video.addEventListener(
    "loadedmetadata",
    () => {
      if (generation !== playerGeneration) {
        return;
      }
      appendLog("浏览器已拿到媒体元数据。");
    },
    { once: true },
  );

  video.addEventListener(
    "playing",
    () => {
      if (generation !== playerGeneration) {
        return;
      }
      if (startupWatchdog) {
        window.clearTimeout(startupWatchdog);
        startupWatchdog = null;
      }
      appendLog("视频已经开始播放。");
    },
    { once: true },
  );

  video.addEventListener(
    "waiting",
    () => {
      if (generation !== playerGeneration) {
        return;
      }
      appendLog("视频缓冲中。");
    },
    { once: false },
  );

  appendLog(`${modeLabel}已连接到代理流: ${playUrl}`);
}

async function createSession(payload) {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "创建播放会话失败。");
  }

  return result;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  currentMode = String(formData.get("mode") || "auto").trim();
  autoFallbackUsed = false;
  currentSession = null;
  resolvedStartupMode = "direct";

  const payload = {
    url: String(formData.get("url") || "").trim(),
    protocolHint: String(formData.get("protocolHint") || "https").trim(),
    rawHeaders: String(formData.get("rawHeaders") || "").trim(),
  };

  try {
    setStatus("正在创建播放会话...");
    appendLog("开始解析请求头并创建代理会话。");

    const session = await createSession(payload);
    currentSession = session;
    resolvedStartupMode = await resolveStartupMode(session);

    setStatus(
      resolvedStartupMode === "transcode" ? "转码兼容播放中" : "播放中",
      session.targetUrl,
    );
    appendLog(`已解析直播地址: ${session.targetUrl}`);
    appendLog(`转发请求头: ${session.forwardedHeaderNames.join(", ") || "无"}`);
    appendLog(`当前播放模式: ${getModeLabel(currentMode)}`);
    if (currentMode === "auto" && resolvedStartupMode === "transcode") {
      appendLog("自动模式已切换到转码兼容模式。");
    }
    createPlayer(session, resolvedStartupMode);
  } catch (error) {
    destroyPlayer();
    setStatus(`启动失败: ${error.message}`);
    appendLog(`启动失败: ${error.message}`);
  }
});

stopBtn.addEventListener("click", () => {
  destroyPlayer();
  currentSession = null;
  autoFallbackUsed = false;
  setStatus("已停止播放");
  appendLog("手动停止播放。");
});

fillDemoBtn.addEventListener("click", () => {
  rawHeadersInput.value = [
    "GET /live/test.flv?token=demo HTTP/1.1",
    "Host: live.example.com",
    "User-Agent: Mozilla/5.0",
    "Accept: */*",
    "Referer: https://live.example.com/player",
    "Origin: https://live.example.com",
    "Cookie: session_id=replace-me",
  ].join("\n");

  document.querySelector("#url").value = "";
  document.querySelector("#protocolHint").value = "https";
  modeInput.value = "auto";
  appendLog("已填入示例请求头。");
});

clearLogBtn.addEventListener("click", () => {
  logElement.textContent = "";
});
