# Loon 插件方案

文件：

- `loon/douyin-live-switch.plugin`
- `loon/loon_capture_douyin_stream.js`
- `loon/loon_rewrite_douyin_response.js`
- `loon/loon_redirect_douyin_stream.js`

## 功能

1. 抓取链接

- 从抖音直播房间接口返回体里抓 FLV
- 从 302 `Location` 里抓 FLV
- 从实际 FLV 请求 URL 里抓 FLV
- 自动把 `http://IP/真实域名/...` 规范化成 `https://真实域名/...`

2. 重写返回内容

- 重写抖音直播接口返回体里的 FLV 地址
- 改写 CDN FLV 请求返回的 `302 Location`
- 把原始直播内容替换成你指定的目标流

3. 请求兜底重定向

- 如果播放器已经开始请求原始 FLV
- 直接把这个请求改到替换流

## 用法

1. 在 Loon 中导入 `douyin-live-switch.plugin`
2. 打开插件配置
3. 你只需要看 3 个项：
   `抓取开关`
   `替换开关`
   `替换 FLV 地址`
4. 想先观察原始直播流：
   打开 `抓取开关`
   关闭 `替换开关`
5. 想替换直播内容：
   打开 `替换开关`
   可选填写 `替换 FLV 地址`
   如果这里留空，插件会自动使用最近抓到的 FLV 链接
6. 进入抖音直播页测试

当前替换逻辑：

- 优先改写 `302 Location`
- 如果播放器继续请求原始 IP FLV，再由请求脚本做最后兜底重定向

## 说明

- 这套方案依赖 Loon 的 `http-response` / `http-request` 脚本能力以及插件参数能力
- 文档依据：
  - Loon 脚本类型文档
  - Loon 插件文档
  - Loon Script API 文档
