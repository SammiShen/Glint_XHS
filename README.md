# 小红书只读 MCP（xhs-readonly-mcp）

一个纯只读的小红书浏览工具，通过 MCP 协议接入对话，可以直接搜索、浏览小红书公开内容。

**不做任何发布、评论、点赞、关注等写入操作** —— 只帮你"看"，不替你"说话"，避免让 AI 冒充真实用户与他人互动。这条边界是有意为之的设计原则，不是技术限制：代码里没有实现任何写入/互动相关的工具。

## 工作原理

- 自动化引擎：Playwright
- 登录方式：通过 CDP（Chrome DevTools Protocol）连接**你本地已经登录小红书的浏览器实例**，不单独启动无头浏览器、不维护 cookie 文件
  - 好处：登录状态始终"新鲜"，也不会触发"同账号多端登录被踢出"
  - 代价：这个 MCP server 必须和你日常浏览器运行在同一台机器上，且该浏览器要以调试模式启动

## 四个只读工具

| 工具 | 说明 |
| --- | --- |
| `search_notes` | 按关键词搜索笔记，返回标题、作者、封面、点赞/收藏/评论数 |
| `get_note_detail` | 输入笔记链接/ID，获取标题、正文、作者、发布时间、图片/视频链接、标签 |
| `get_note_comments` | 输入笔记链接/ID，获取评论列表（评论者、内容、点赞数、回复关系） |
| `get_user_profile` | 输入用户主页链接/ID，获取该用户公开笔记列表和基础信息 |

## 一、启动一个带调试端口的浏览器

**先关闭所有已打开的 Chrome 窗口**（否则新参数不会生效），然后用命令行重新打开：

macOS：
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.xhs-mcp-chrome-profile"
```

Windows（PowerShell）：
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:USERPROFILE\.xhs-mcp-chrome-profile"
```

Linux：
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.xhs-mcp-chrome-profile"
```

> 建议用独立的 `--user-data-dir`（一个新的空文件夹），这样第一次需要手动扫码/登录一次小红书，之后这个 profile 会一直保持登录状态，也不会跟你平时用的默认 Chrome 数据混在一起。

打开后，在这个浏览器窗口里访问 [xiaohongshu.com](https://www.xiaohongshu.com) 并登录你的账号。**同一账号同一时间不要在其他网页端登录**，避免与这里的会话冲突。

## 二、安装并构建

```bash
cd xiaohongshu-mcp
npm install
npm run build
```

## 三、接入 MCP 客户端

以 Claude Code / Claude Desktop 的配置为例，在 `mcpServers` 里加一项：

```json
{
  "mcpServers": {
    "xhs-readonly": {
      "command": "node",
      "args": ["/绝对路径/xiaohongshu-mcp/dist/index.js"],
      "env": {
        "XHS_CDP_URL": "http://localhost:9222"
      }
    }
  }
}
```

如果你在别的端口启动了调试浏览器，把 `XHS_CDP_URL` 改成对应地址即可。

## 环境变量（可选）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `XHS_CDP_URL` | `http://localhost:9222` | 浏览器调试地址 |
| `XHS_MIN_DELAY_MS` | `1500` | 两次操作之间的最小间隔（毫秒） |
| `XHS_MAX_DELAY_JITTER_MS` | `1200` | 间隔的随机抖动上限（毫秒） |
| `XHS_MAX_SCROLL_ROUNDS` | `8` | 单次调用最多滚动加载几屏 |
| `XHS_NAV_TIMEOUT_MS` | `20000` | 页面导航超时时间 |
| `XHS_RESPONSE_TIMEOUT_MS` | `15000` | 等待接口响应的超时时间 |

内置了节流：每次操作之间会强制间隔约 1.5～2.7 秒，避免请求过于频繁触发小红书的风控。

## 关于稳定性的说明

小红书没有官方开放 API，这个工具是通过拦截页面自身发出的接口请求（以及读取页面初始状态）来解析数据的，**本质上是爬虫，对页面/接口结构的变化很敏感**。代码里对每个工具都做了兜底：接口拦截失败时会尝试从页面 DOM 里抓取，两者都失败会抛出明确的错误信息（比如提示"可能未登录"或"页面结构可能已变化"）。

如果某个工具突然返回空结果或报错：
1. 先确认调试浏览器里的小红书是否仍处于登录状态；
2. 用调试浏览器手动打开对应的搜索/笔记页面，确认内容能正常显示；
3. 打开浏览器开发者工具的 Network 面板，确认接口路径（`/api/sns/web/v1/search/notes`、`/api/sns/web/v1/feed`、`/api/sns/web/v2/comment/page`、`/api/sns/web/v1/user/otherinfo`、`/api/sns/web/v1/user_posted`）是否还是这些；如果变了，需要相应修改 `src/xhs/*.ts` 里的解析逻辑。

## 使用限制

- 抓取到的内容属于小红书用户生成内容（UGC），仅用于个人浏览辅助，不做二次分发或商用
- 遵守小红书平台规则，避免过度频繁请求
- 明确不做：发布笔记、发表评论、点赞/收藏/关注等任何互动操作，以及任何无需用户逐次确认的写入类操作
