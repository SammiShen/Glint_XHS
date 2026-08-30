/** 环境变量未设置/为空时使用默认值；一旦显式设置了但不是合法的非负整数，直接抛错而不是静默兜底。 */
export function parseNonNegativeInt(raw: string | undefined, defaultValue: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const num = Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    throw new Error(`环境变量 ${name} 的值无效："${raw}"，必须是一个 >= 0 的整数。`);
  }
  return num;
}

/** 同上，但要求正整数（用于超时时间、滚动轮数、端口号这类不允许为 0 的配置）。 */
export function parsePositiveInt(raw: string | undefined, defaultValue: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const num = Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new Error(`环境变量 ${name} 的值无效："${raw}"，必须是一个正整数。`);
  }
  return num;
}

export function normalizeCdpUrl(raw: string | undefined, defaultValue: string): string {
  const value = raw && raw.trim() !== "" ? raw.trim() : defaultValue;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`环境变量 XHS_CDP_URL 不是合法的 URL："${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`环境变量 XHS_CDP_URL 的协议必须是 http 或 https："${value}"`);
  }
  return value;
}

export const config = {
  // 本地 Chrome/Edge 的远程调试地址。用 127.0.0.1 而不是 localhost，避免部分系统上
  // localhost 优先解析到 ::1（IPv6）导致明明浏览器在监听却连不上的问题。
  cdpUrl: normalizeCdpUrl(process.env.XHS_CDP_URL, "http://127.0.0.1:9222"),
  // 两次页面操作之间的最小间隔（毫秒），避免请求过于频繁触发风控。
  minDelayMs: parseNonNegativeInt(process.env.XHS_MIN_DELAY_MS, 1500, "XHS_MIN_DELAY_MS"),
  maxDelayJitterMs: parseNonNegativeInt(process.env.XHS_MAX_DELAY_JITTER_MS, 1200, "XHS_MAX_DELAY_JITTER_MS"),
  // 单次调用最多滚动加载几屏，防止无限滚动导致长时间挂起。
  maxScrollRounds: parsePositiveInt(process.env.XHS_MAX_SCROLL_ROUNDS, 8, "XHS_MAX_SCROLL_ROUNDS"),
  navigationTimeoutMs: parsePositiveInt(process.env.XHS_NAV_TIMEOUT_MS, 20000, "XHS_NAV_TIMEOUT_MS"),
  responseTimeoutMs: parsePositiveInt(process.env.XHS_RESPONSE_TIMEOUT_MS, 15000, "XHS_RESPONSE_TIMEOUT_MS"),
  // 以下两项目前只被 scripts/start-debug-browser.mjs 使用（该脚本是独立的 .mjs，不会 import 这里，
  // 但环境变量名保持一致，方便用户只需要记一套变量名）。
  cdpPort: parsePositiveInt(process.env.XHS_CDP_PORT, 9222, "XHS_CDP_PORT"),
  chromePath: process.env.XHS_CHROME_PATH,
  chromeProfileDir: process.env.XHS_CHROME_PROFILE_DIR,
};
