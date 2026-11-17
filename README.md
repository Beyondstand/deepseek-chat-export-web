# DeepSeek 会话导出工具（纯前端网页）

**零安装、零后端、零权限**：打开网页 → 在 DeepSeek 页面点一下书签 → 全部会话出现在网页里 → 一键导出 **HTML**（精美排版）或 **TXT** 文件。

> 非官方工具，与 DeepSeek 无关。接口为非公开 API，随官网改版可能需要更新。

---

## 三步上手

1. 用浏览器打开本工具的网页地址（部署到自己的 GitHub Pages 后就是一个固定链接）；
2. 把页面上的 **「📚 DeepSeek 一键导出」书签** 拖到浏览器**书签栏**；
3. 登录 [chat.deepseek.com](https://chat.deepseek.com)，在该页面点击这条书签。

此时工具页自动弹出并列出你的**全部会话**；点任意会话即可预览，点 **⬇ 导出 HTML / TXT** 下载。

第一次用想先看看效果？访问 **`?demo=1`**（如 `https://you.github.io/repo/?demo=1`）加载演示数据。

## 为什么还需要一个「书签脚本」？

浏览器安全限制：**任何外部网页都不能直接调用 DeepSeek 的接口**（跨域 CORS 被拦截，本仓库 `tools/cors-test.html` 可复现验证）。所以分工是：

- **书签脚本**运行在 `chat.deepseek.com` 自己页面里（同源、天然放行）：读取你浏览器里的登录态（**token 由它自动获取，你不用复制粘贴**），调用只读接口拉会话；
- **工具网页**负责：会话列表、预览、渲染导出文件、接收脚本推来的数据（`postMessage`）。

没有服务器参与：数据只在你自己的两个浏览器标签页之间传递。

## 导出的文件

| 格式 | 用途 |
|---|---|
| **HTML**（默认推荐） | 单文件、排版美观、含折叠的思考过程和搜索引用，可直接离线打开或转发分享 |
| **TXT** | 纯文本，兼容所有工具 |

文件名：`DeepSeek_<会话标题>_<时间戳>.html/.txt`。「全部导出」会逐个下载多个文件。

## 隐私说明

- 书签脚本在 DeepSeek 页面内**现读** `localStorage.userToken`，只用于同源 API 请求；**不上传、不落盘、不出浏览器**；
- 会话数据经 `postMessage` 直达你打开的工具页，**没有任何第三方服务器**；
- 工具页本身无统计、无追踪、可断网使用（除书签脚本拉取数据外）。

## 部署到 GitHub Pages（让自己和用户有一个固定链接）

1. 把本仓库推到自己 GitHub 账号下；
2. 仓库 **Settings → Pages → Source** 选 `Deploy from a branch`，分支 `main` / 目录 `/ (root)`，保存；
3. 约 1 分钟后 `https://<用户名>.github.io/<仓库名>/` 即为工具地址；
4. 打开该地址，页面会自动生成填好自己地址的书签链接。

可选：绑自定义域名（Settings → Pages → Custom domain）。

## 兜底方案（不想用书签）

网页底部支持直接粘贴：**DeepSeek 导出的 JSON**（控制台脚本产物 / 官方「导出全部历史对话」解压出的 conversations.json / 接口原始响应）或**任意对话文本**，点击「按 JSON / 纯文本导入」即可预览导出。

## FAQ

**Q：书签脚本安全吗？它不会把我的 token 发到别处吗？**
脚本全部代码公开在本仓库（`tools/bookmarklet.js`，网页上也能查看）；它在 DeepSeek 页面内同源请求 `chat.deepseek.com`，token 只放进请求头，没有任何其他网络行为。

**Q：换账号 / 退出登录怎么办？**
token 每次点书签时现读，自动跟随当前登录的账号。

**Q：会话很多，拉取慢怎么办？**
列表立刻到达；详情逐个节流（350ms/个）陆续推送到网页，你可以边收边导出。默认最多 300 个会话（脚本顶部 `MAX_SESSIONS` 可调）。

**Q：Firefox / Safari 能用吗？**
能。本方案只用同源 fetch + postMessage 等通用能力，不依赖 Chromium 专属 API。

**Q：点了书签没反应？**
多半是弹窗被拦截——允许该站弹窗后重试；或检查 DeepSeek 是否处于登录状态。

**Q：导出的 HTML 里对话内容会被当成网页代码执行吗？**
不会，全部内容都经过转义（演示数据里故意放了一段 `<script>` 用于验证）。

## 目录结构

```
deepseek-chat-export-web/
├── index.html            工具页
├── app.js                页面逻辑（接收数据/预览/导出/兜底导入）
├── shared.js             归一化 + TXT/HTML 渲染（浏览器与 Node 测试共用）
├── style.css             样式
├── demo-data.js          演示数据（?demo=1）
├── tools/
│   ├── bookmarklet.js    书签脚本源码（网页自动生成拖拽链接）
│   └── cors-test.html    跨域拦截复现工具（ diagnostic ）
└── tests/test-shared.mjs 单元测试（npm test）
```

## License

MIT
