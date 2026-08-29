import type { Page, Response } from "playwright";
import { config } from "../config.js";

/**
 * 从各种形式的小红书链接/ID 中解析出 noteId 和 xsec_token（部分详情/评论接口需要 token 才能正常返回）。
 */
export function parseNoteRef(input: string): { noteId: string; xsecToken?: string } {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    // 直接传入的是 noteId（24 位十六进制字符串）
    return { noteId: trimmed };
  }
  const url = new URL(trimmed);
  const segments = url.pathname.split("/").filter(Boolean);
  const noteId = segments[segments.length - 1];
  const xsecToken = url.searchParams.get("xsec_token") ?? undefined;
  if (!noteId) {
    throw new Error(`无法从链接中解析出笔记 ID：${input}`);
  }
  return { noteId, xsecToken };
}

export function buildExploreUrl(noteId: string, xsecToken?: string): string {
  const url = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
  if (xsecToken) {
    url.searchParams.set("xsec_token", xsecToken);
    url.searchParams.set("xsec_source", "pc_search");
  }
  return url.toString();
}

export function parseUserRef(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const url = new URL(trimmed);
  const segments = url.pathname.split("/").filter(Boolean);
  const userId = segments[segments.length - 1];
  if (!userId) {
    throw new Error(`无法从链接中解析出用户 ID：${input}`);
  }
  return userId;
}

/** 小红书接口/页面里常见的 "1.2万" "3556" 这类互动数字，统一转成 number。 */
export function parseCount(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (typeof raw === "number") return raw;
  const str = String(raw).trim();
  if (/^\d+$/.test(str)) return Number(str);
  const match = str.match(/^([\d.]+)\s*(万|亿)?$/);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (Number.isNaN(base)) return undefined;
  if (match[2] === "万") return Math.round(base * 10_000);
  if (match[2] === "亿") return Math.round(base * 100_000_000);
  return base;
}

/**
 * 在触发页面导航/交互之前先挂好 response 监听，等待第一个匹配 urlIncludes 的、
 * 状态码 2xx 的 JSON 响应。避免"请求已经发出但监听器还没挂上"导致错过响应。
 */
export async function captureJsonResponse<T = unknown>(
  page: Page,
  urlIncludes: string,
  trigger: () => Promise<unknown>,
  timeoutMs: number = config.responseTimeoutMs,
): Promise<T | null> {
  const waiter = page
    .waitForResponse(
      (res: Response) => res.url().includes(urlIncludes) && res.status() >= 200 && res.status() < 300,
      { timeout: timeoutMs },
    )
    .then((res: Response) => res.json() as Promise<T>)
    .catch(() => null);

  await trigger();
  return waiter;
}

/**
 * 收集触发某个滚动/交互动作之后，一段时间窗口内所有匹配 urlIncludes 的 JSON 响应。
 * 用于评论区这种"一次滚动可能触发多个分页请求"的场景。
 */
export function collectJsonResponses<T = unknown>(
  page: Page,
  urlIncludes: string,
): { results: T[]; stop: () => void } {
  const results: T[] = [];
  const handler = (res: Response) => {
    if (res.url().includes(urlIncludes) && res.status() >= 200 && res.status() < 300) {
      res
        .json()
        .then((json) => results.push(json as T))
        .catch(() => {});
    }
  };
  page.on("response", handler);
  return {
    results,
    stop: () => page.off("response", handler),
  };
}

export async function readInitialState<T = unknown>(page: Page): Promise<T | undefined> {
  return page.evaluate(() => {
    // @ts-expect-error 小红书页面注入的全局变量，类型未知
    return window.__INITIAL_STATE__;
  });
}

export async function scrollDown(page: Page): Promise<void> {
  await page.mouse.wheel(0, 2400);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 返回第一个非 undefined/null 的值，用于同一字段在不同接口/版本下命名不一致的兜底取值。 */
export function firstDefined<T>(...values: (T | undefined | null)[]): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** 安全地按路径读取嵌套对象的值，任意一层不存在都返回 undefined 而不是抛错。 */
export function getPath(obj: unknown, path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}
