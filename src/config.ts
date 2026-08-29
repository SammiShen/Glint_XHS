export const config = {
  // 本地 Chrome/Edge 的远程调试地址，需要用户自行以 --remote-debugging-port 启动并登录小红书。
  cdpUrl: process.env.XHS_CDP_URL ?? "http://localhost:9222",
  // 两次页面操作之间的最小间隔（毫秒），避免请求过于频繁触发风控。
  minDelayMs: Number(process.env.XHS_MIN_DELAY_MS ?? 1500),
  maxDelayJitterMs: Number(process.env.XHS_MAX_DELAY_JITTER_MS ?? 1200),
  // 单次调用最多滚动加载几屏，防止无限滚动导致长时间挂起。
  maxScrollRounds: Number(process.env.XHS_MAX_SCROLL_ROUNDS ?? 8),
  navigationTimeoutMs: Number(process.env.XHS_NAV_TIMEOUT_MS ?? 20000),
  responseTimeoutMs: Number(process.env.XHS_RESPONSE_TIMEOUT_MS ?? 15000),
};
