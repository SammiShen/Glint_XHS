# 小红书只读 MCP（xhs-readonly-mcp）

一个纯只读的小红书浏览工具，通过 MCP 协议接入对话，可以直接搜索、浏览小红书公开内容。

**不做任何发布、评论、点赞、关注等写入操作** —— 只帮你"看"，不替你"说话"，避免让 AI 冒充真实用户与他人互动。这条边界是有意为之的设计原则，不是技术限制：代码里没有实现任何写入/互动相关的工具。

## 工作原理

- 自动化引擎：Playwright
- 登录方式：通过 CDP（Chrome DevTools Protocol）连接**你本地已经登录小红书的浏览器实例**，不单独启动无头浏览器、不维护 cookie 文件
  - 好处：登录状态始终"新鲜"，也不会触发"同账号多端登录被踢出"
  - 代价：这个 MCP server 必须和你日常浏览器运行在同一台机器上，且该浏览器要以调试模式启动，**并且在每次调用 MCP 工具时都保持运行**

> **重要**：MCP server 本身被 Claude Desktop 发现并能列出工具，**不代表**调试浏览器也已经连接好了。这是两件独立的事——server 只是一段常驻进程，真正干活时才会去连 CDP。如果浏览器没开、端口不对，工具调用就会失败，这是正常现象，不是 bug。

## 四个只读工具

| 工具 | 说明 |
| --- | --- |
| `search_notes` | 按关键词搜索笔记，返回标题、作者、封面、点赞/收藏/评论数 |
| `get_note_detail` | 输入笔记链接/ID，获取标题、正文、作者、发布时间、图片/视频链接、标签 |
| `get_note_comments` | 输入笔记链接/ID，获取评论列表（评论者、内容、点赞数、回复关系） |
| `get_user_profile` | 输入用户主页链接/ID，获取该用户公开笔记列表和基础信息 |

## 一、安装并构建

```bash
npm install
npm run build
```

## 二、启动一个带调试端口的浏览器

### 方式一（推荐）：一键启动脚本

```bash
npm run browser:mac
```

这个脚本会：
- 用**独立的 profile**（默认 `~/.xhs-mcp-chrome-profile`）启动 Chrome，不会碰你日常使用的默认 Chrome profile/登录态；
- 默认使用端口 `9222`；
- 如果这个端口已经有一个可用的 CDP 端点在跑，直接复用，不会重复启动；
- 如果端口被别的、不是 Chrome 调试端口的程序占用，会明确报错并退出，不会瞎启动；
- 启动成功后打印 CDP URL、profile 路径，并提醒你**首次使用时要在这个窗口里手动登录一次小红书**。

尽管脚本叫 `browser:mac`，Windows/Linux 上也能跑（默认路径分别是 Chrome 的常规安装路径 / `google-chrome`），只是目前测得最全的是 macOS。找不到 Chrome 或者路径不对时，用 `XHS_CHROME_PATH` 指定可执行文件路径即可，见下方环境变量表。

### 方式二：手动用命令行启动

**先关闭所有已打开的 Chrome 窗口**（否则新参数不会生效），然后：

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

> 必须带独立的 `--user-data-dir`（一个新的空文件夹）。只加 `--remote-debugging-port` 而不指定独立 profile，很可能会因为"已有一个 Chrome 实例在用默认 profile"而不生效。

打开后，在这个浏览器窗口里访问 [xiaohongshu.com](https://www.xiaohongshu.com) 并登录你的账号。**同一账号同一时间不要在其他网页端登录**，避免与这里的会话冲突。**这个浏览器窗口需要在你使用 MCP 工具期间一直保持运行**，关掉它 = MCP 工具会连不上。

## 三、验证调试浏览器是否已经就绪

在接入 MCP 客户端之前，先自己确认一下 CDP 端点是不是真的通了：

```bash
curl http://127.0.0.1:9222/json/version
```

- 如果返回一段包含 `webSocketDebuggerUrl` 字段的 JSON，说明浏览器端一切正常。
- 如果提示连接被拒绝（`Failed to connect` / `Connection refused`），说明浏览器还没启动，回到第二步。
- 如果返回了内容但不像上面这种 JSON，说明这个端口被别的程序占用了，换个端口（`XHS_CDP_PORT`）。

这一步通过之后，MCP 工具调用时的 CDP 连接才有可能成功。

## 四、接入 MCP 客户端

以 Claude Code / Claude Desktop 的配置为例，在 `mcpServers` 里加一项：

```json
{
  "mcpServers": {
    "xhs-readonly": {
      "command": "node",
      "args": ["/绝对路径/glint_xhs/dist/index.js"],
      "env": {
        "XHS_CDP_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```

如果你在别的端口启动了调试浏览器，把 `XHS_CDP_URL` 改成对应地址即可。**注意 Claude Desktop 能列出这几个工具，只说明 MCP server 进程本身启动成功，不代表调试浏览器已经连上**——真正调用工具时才会去连 CDP，浏览器没开的话调用会报错（见上面"验证"一节）。改完配置后重启一下 Claude Desktop 让它重新加载。

## 环境变量（可选）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `XHS_CDP_URL` | `http://127.0.0.1:9222` | MCP server 连接浏览器用的调试地址。用 `127.0.0.1` 而不是 `localhost`，避免部分系统上 `localhost` 优先解析到 IPv6（`::1`）导致明明浏览器在监听却连不上 |
| `XHS_MIN_DELAY_MS` | `1500` | 两次操作之间的最小间隔（毫秒），必须 ≥ 0 的整数 |
| `XHS_MAX_DELAY_JITTER_MS` | `1200` | 间隔的随机抖动上限（毫秒），必须 ≥ 0 的整数 |
| `XHS_MAX_SCROLL_ROUNDS` | `8` | 单次调用最多滚动加载几屏，必须是正整数 |
| `XHS_NAV_TIMEOUT_MS` | `20000` | 页面导航超时时间，必须是正整数 |
| `XHS_RESPONSE_TIMEOUT_MS` | `15000` | 等待接口响应的超时时间，必须是正整数 |
| `XHS_CDP_PORT` | `9222` | 仅供 `npm run browser:mac` 一键启动脚本使用：启动 Chrome 时用哪个调试端口 |
| `XHS_CHROME_PATH` | 按平台自动选择 | 仅供一键启动脚本使用：Chrome 可执行文件路径，自动探测失败/路径不对时指定 |
| `XHS_CHROME_PROFILE_DIR` | `~/.xhs-mcp-chrome-profile` | 仅供一键启动脚本使用：独立 Chrome profile 目录 |

以上数值型环境变量如果设置了但不是合法值（比如负数、非整数、`NaN`），MCP server 启动时会直接抛出明确的错误，而不是静默套用默认值继续跑。

内置了真正串行的节流：任意两次页面操作之间都会强制间隔约 1.5～2.7 秒（并发调用会排队等待，不会同时放行），避免请求过于频繁触发小红书的风控。

## 关于稳定性的说明

小红书没有官方开放 API，这个工具是通过拦截页面自身发出的接口请求（以及读取页面初始状态）来解析数据的，**本质上是爬虫，对页面/接口结构的变化很敏感**。代码里对每个工具都做了兜底：接口拦截失败时会尝试从页面 DOM 里抓取，两者都失败会抛出明确的错误信息（比如提示"可能未登录"或"页面结构可能已变化"）。

如果某个工具突然返回空结果或报错：
1. 先按上面第三步用 `curl` 确认 CDP 端点本身是通的；
2. 确认调试浏览器里的小红书是否仍处于登录状态；
3. 用调试浏览器手动打开对应的搜索/笔记页面，确认内容能正常显示；
4. 打开浏览器开发者工具的 Network 面板，确认接口路径（`/api/sns/web/v1/search/notes`、`/api/sns/web/v1/feed`、`/api/sns/web/v2/comment/page`、`/api/sns/web/v1/user/otherinfo`、`/api/sns/web/v1/user_posted`）是否还是这些；如果变了，需要相应修改 `src/xhs/*.ts` 里的解析逻辑。

## 开发 / 测试

```bash
npm run typecheck   # 只做类型检查
npm run build       # 编译到 dist/
npm test            # 编译 + 跑单元测试（Node 内置 test runner，无需额外依赖）
```

单元测试覆盖的是纯逻辑部分（`parseCount` / `parseNoteRef` / `parseUserRef`、配置解析、CDP 探测的分支判断、节流器的并发行为），**不包含**真正连接浏览器抓取小红书数据——那部分需要你本机真的开着登录了小红书的调试浏览器才能验证，参考上面"验证调试浏览器是否已经就绪"一节。

## 使用限制

- 抓取到的内容属于小红书用户生成内容（UGC），仅用于个人浏览辅助，不做二次分发或商用
- 遵守小红书平台规则，避免过度频繁请求
- 明确不做：发布笔记、发表评论、点赞/收藏/关注等任何互动操作，以及任何无需用户逐次确认的写入类操作
