# Tampermonkey 真实浏览器替换方案

文件：

- `scripts/douyin-live-rewriter.user.js`

用途：

- 运行在真实抖音直播页里
- 保留网站原来的播放器
- 在页面初始化阶段重写抓到的直播流地址
- 自动抓取当前页里出现过的候选流链接

## 安装

1. 浏览器安装 Tampermonkey
2. 新建脚本
3. 把 `douyin-live-rewriter.user.js` 全部内容粘进去并保存
4. 打开目标直播页

## 使用

页面右上角会出现 `Douyin Rewriter` 面板：

- `启用`：开启重写
- `替换流地址`：填你想让官方播放器使用的直播流 URL
- `命中过滤关键字`：默认 `douyincdn.com`
- `可选 Host 覆盖`：需要时可填目标 host
- `抓取当前页链接`：扫描当前页和已拦截的接口结果里的候选流链接
- 候选列表里的 `用这个`：把抓到的链接直接填进替换框

保存后页面会自动刷新。

## 当前实现

脚本会尝试拦截并重写：

- `fetch` 返回的 JSON / 文本
- `XMLHttpRequest` 返回的 JSON / 文本
- `JSON.parse`
- 一批常见的全局初始化对象

脚本会尝试抓取：

- 页面接口响应里出现的 URL
- 页面脚本内嵌 JSON 里的 URL
- 当前窗口对象树里出现的 URL

## 控制台调试

脚本还暴露了一个调试对象：

```js
window.__DOUYIN_REWRITER__.getCapturedUrls()
window.__DOUYIN_REWRITER__.collectNow()
```

## 限制

- 这是“借用真实页面原播放器”的通用脚本，不保证一次命中站点全部内部字段
- 如果目标站点把播放器配置放进更深的闭包、Worker 或 wasm，这个版本还需要继续定制
- 如果页面播放器本身也不支持目标流的编码，单纯替换 URL 仍然播不了
