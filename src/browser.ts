import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";
import { log } from "./logger.js";
import { checkCdpEndpoint, formatCdpError } from "./cdp.js";
import { createThrottler } from "./throttle.js";

const XHS_HOST = "xiaohongshu.com";

let browserPromise: Promise<Browser> | null = null;

/**
 * 连接到用户本地已经登录小红书的浏览器实例（通过 CDP），而不是启动一个全新的
 * 无头浏览器。这样不需要单独维护 cookie 文件，也不会触发"同账号多端登录被踢出"。
 */
async function connect(): Promise<Browser> {
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  browser.on("disconnected", () => {
    log("CDP 连接已断开，下次调用会尝试重新连接");
    browserPromise = null;
  });
  return browser;
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      // 先探测 /json/version，把"端口没监听" / "端口被别的程序占用" / "网络不通"
      // 这几种情况区分开，而不是笼统地报"可能未登录"。
      const preflight = await checkCdpEndpoint(config.cdpUrl);
      if (preflight.status !== "ok") {
        throw new Error(formatCdpError(config.cdpUrl, preflight));
      }
      try {
        return await connect();
      } catch (err) {
        // 探测正常但 Playwright 自己连接失败，是第三种、更少见的情况，单独给出说明。
        throw new Error(
          `CDP 探测（/json/version）正常，但 Playwright 通过 connectOverCDP 建立连接失败。\n` +
            "可能原因：该端口不是 Chromium 内核浏览器、调试协议版本不兼容，或浏览器在探测后立刻退出了。\n" +
            `原始错误：${(err as Error).message}`,
        );
      }
    })().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/**
 * 复用已登录的浏览器上下文（保留 cookie/登录态），而不是新建一个空白 context。
 * 优先复用已经打开的小红书标签页；否则在已有 context 里新开一个标签页。
 */
async function getXhsContext(browser: Browser): Promise<BrowserContext> {
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error(
      "CDP 连接成功，但没有发现任何浏览器窗口/上下文。请确认调试端口连接的是你正在使用的那个浏览器实例。",
    );
  }
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      if (page.url().includes(XHS_HOST)) {
        return ctx;
      }
    }
  }
  // 没有已打开的小红书标签页，退回第一个 context（会新开标签页并跳转过去）。
  return contexts[0];
}

const throttler = createThrottler(() => config.minDelayMs + Math.random() * config.maxDelayJitterMs);

/**
 * 获取一个可用的小红书标签页，并在使用前做节流（真正串行排队，见 throttle.ts）。
 * 每次调用都会打开一个新标签页用于本次操作，用完后关闭它，
 * 尽量不打扰用户原本打开的标签页（例如首页 feed 的滚动位置）。
 */
export async function withXhsPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  await throttler.wait();
  const browser = await getBrowser();
  const ctx = await getXhsContext(browser);
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/** 页面导航后调用，检测是否疑似未登录，便于工具返回更友好的错误提示。 */
export async function looksLoggedOut(page: Page): Promise<boolean> {
  return page
    .locator("text=登录")
    .first()
    .isVisible()
    .catch(() => false);
}
