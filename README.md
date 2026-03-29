# FLV 直播播放器

一个最小可运行的本地 FLV 播放器：

- 前端粘贴完整请求头
- 后端按这些 header 去请求上游 FLV 直播流
- 浏览器通过 `flv.js` 播放本地代理地址
- 如果上游 FLV 编码浏览器不支持，自动切换到 `ffmpeg` 转码兼容模式

## 启动

```bash
npm install
npm start
```

默认地址：`http://localhost:3000`

## 使用方式

1. 打开页面
2. 粘贴完整请求头
3. 如果原始文本里没有请求行或 `:path`，在“播放地址”里手动填入完整 FLV 地址
4. 点击“开始播放”

如果日志里出现 `Unsupported codec in video frame: 12` 这类错误，说明原始 FLV 里的视频编码不被 `flv.js` 直接支持。当前版本会在“自动”模式下自动回退到 `ffmpeg` 转码；也可以手动切到“转码”模式。

## 支持的请求头格式

### 普通 HTTP 请求

```http
GET /live/room.flv?token=abc HTTP/1.1
Host: live.example.com
Referer: https://live.example.com/player
User-Agent: Mozilla/5.0
Cookie: session=xxx
```

### HTTP/2 伪头

```http
:method: GET
:scheme: https
:authority: live.example.com
:path: /live/room.flv?token=abc
Cookie: session=xxx
```

## 注意

- 当前只支持 `GET` 类型的 FLV 直播流
- 只能复用你已经拿到的合法地址和请求头
- 不处理 DRM、签名算法生成、WebSocket 直播流
- 会话默认 30 分钟无访问后过期
- 转码模式依赖本机 `ffmpeg`
