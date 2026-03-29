# Loon 插件说明

核心文件：
- `loon/douyin-live-switch.plugin`
- `loon/loon_capture_douyin_stream.js`
- `loon/loon_capture_toggle_sync.js`
- `loon/loon_rewrite_douyin_dispatch_json.js`
- `loon/loon_rewrite_douyin_location.js`
- `loon/loon_redirect_douyin_direct_request.js`

## 当前逻辑

1. 抓取

- `抓取开关` 打开后，只锁定第一条命中的目标流。
- 同一条流里如果先命中较弱的 `200 直连`，后面又来了更强的 `调度 JSON` 或 `302`，会自动升级成更准确的目标。
- `抓取开关` 关闭后会立刻解锁；再次打开时，下一条新的直播流会重新抓取。

2. 替换

- 如果当前抓到的是 `302` 目标，就改第一跳响应里的 `Location`。
- 如果当前抓到的是 `调度 JSON` 目标，就改响应体里的 `complete_url`、`ip`、`port`。
- 如果当前抓到的是 `200 直连` 目标，就改同类直连请求本身。

3. 兼容范围

- Host：`*.douyincdn.com`、`*.flive.douyincdn.com`、`*.douyinliving.com`
- 路径：`third`、`stage`、`thirdgame`、`fantasy` 以及同类 `.flv` 路径
- 入口类型：
  - `302 Location`
  - `200 application/json` 调度响应
  - `200 video/x-flv` 直连响应

## 使用方法

1. 在 Loon 中导入 `douyin-live-switch.plugin`
2. 打开 `抓取开关`
3. 进入要抓的直播，等待抓取通知
4. 关闭 `抓取开关`
5. 打开 `替换开关`
6. 再进入其他直播，看是否被替换

可选项：
- `替换 FLV 地址` 留空时，默认使用最近一次抓到的目标地址
- `替换 FLV 地址` 手动填写后，优先使用你填写的目标地址

## 验证结论

历史抓包回放的结论是：
- 大多数命中的请求都能成功抓取并通知
- 少数“不通知”的样本，根因是上游调度 JSON 自己返回了空 `complete_url`，这类请求本身没有可抓目标
- 这种情况后面通常还会跟着同流的 `302` 或 `200 直连`，插件会在那些入口上继续抓取
