/**
 * 对 Chrome DevTools Protocol 的 /json/version 端点做探测，用来在调用
 * playwright.chromium.connectOverCDP() 之前区分几种不同的失败原因：
 *   - 端口根本没有监听（还没启动调试浏览器）
 *   - 端口被占用，但响应内容不是合法的 DevTools 端点（被别的程序占用了）
 *   - 探测本身超时/网络不通
 * 探测通过之后，如果 connectOverCDP 依然失败，那是另一类问题（见 browser.ts）。
 */
export type CdpPreflightResult =
  | { status: "ok"; browser?: string; webSocketDebuggerUrl?: string }
  | { status: "connection-refused" }
  | { status: "invalid-response"; detail: string }
  | { status: "unreachable"; detail: string };

export async function checkCdpEndpoint(cdpUrl: string, timeoutMs = 3000): Promise<CdpPreflightResult> {
  let versionUrl: string;
  try {
    versionUrl = new URL("/json/version", cdpUrl).toString();
  } catch {
    return { status: "unreachable", detail: `CDP 地址不是合法 URL：${cdpUrl}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(versionUrl, { signal: controller.signal });
    if (!res.ok) {
      return { status: "invalid-response", detail: `HTTP ${res.status} ${res.statusText}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { status: "invalid-response", detail: "响应内容不是合法的 JSON" };
    }
    if (typeof json !== "object" || json === null) {
      return { status: "invalid-response", detail: "响应内容不是一个 JSON 对象" };
    }
    const obj = json as Record<string, unknown>;
    const webSocketDebuggerUrl = typeof obj.webSocketDebuggerUrl === "string" ? obj.webSocketDebuggerUrl : undefined;
    const browser = typeof obj.Browser === "string" ? obj.Browser : undefined;
    if (!webSocketDebuggerUrl && !browser) {
      return {
        status: "invalid-response",
        detail: "响应里既没有 webSocketDebuggerUrl 也没有 Browser 字段，不像是 Chrome DevTools 的 /json/version",
      };
    }
    return { status: "ok", browser, webSocketDebuggerUrl };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
    if (cause?.code === "ECONNREFUSED") {
      return { status: "connection-refused" };
    }
    if ((err as Error).name === "AbortError") {
      return { status: "unreachable", detail: `请求超时（${timeoutMs}ms）` };
    }
    return { status: "unreachable", detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

const MAC_LAUNCH_CMD =
  '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\\n' +
  "  --remote-debugging-port=9222 \\\n" +
  '  --user-data-dir="$HOME/.xhs-mcp-chrome-profile"';

/** 把探测结果转成面向用户的中文错误说明，三种失败原因分别给出不同的排查建议。 */
export function formatCdpError(cdpUrl: string, preflight: CdpPreflightResult): string {
  switch (preflight.status) {
    case "connection-refused":
      return (
        `无法连接到 CDP 地址（${cdpUrl}）：端口未监听（ECONNREFUSED）。\n` +
        "这说明还没有一个带调试端口的浏览器在运行，需要先手动启动一个。\n\n" +
        "推荐：在项目目录下运行一键启动脚本：\n" +
        "  npm run browser:mac\n\n" +
        "或者手动用命令行启动（必须带独立 profile，不要只加 --remote-debugging-port）：\n" +
        `${MAC_LAUNCH_CMD}\n\n` +
        "启动后在这个浏览器窗口里登录一次小红书账号，保持窗口运行，然后重试。"
      );
    case "invalid-response":
      return (
        `CDP 地址（${cdpUrl}）的 /json/version 有 HTTP 响应，但内容不是合法的 Chrome DevTools 端点` +
        `（${preflight.detail}）。\n` +
        "最可能的原因：这个端口被其他程序占用了，不是 Chrome 的调试端口。\n" +
        "请通过 XHS_CDP_PORT（配合 Chrome 的 --remote-debugging-port）换一个端口启动调试浏览器，" +
        "并同步把 XHS_CDP_URL 改成新地址。"
      );
    case "unreachable":
      return (
        `无法访问 CDP 地址（${cdpUrl}）：${preflight.detail}。\n` +
        "请确认地址、端口和网络/防火墙设置是否正确，并且该浏览器仍在运行。"
      );
    case "ok":
      return "CDP 端点探测正常（不应该走到这个错误分支，如果看到这条消息说明代码有 bug）。";
  }
}
