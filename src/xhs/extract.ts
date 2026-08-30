import type { Page, Response } from "playwright";
import { config } from "../config.js";

const XHS_HOST_SUFFIX = "xiaohongshu.com";
// 宽松但不失底线的 ID 格式：字母数字（外加 - _），长度 6~64。
// 目前观察到的小红书笔记/用户 ID 是 24 位十六进制字符串，但没有把长度/字符集写死到刚好 24 位，
// 避免以后格式变化就直接判定所有输入非法；这里只挡明显不是 ID 的垃圾输入（整句话、域名、空字符串等）。
const ID_PATTERN = /^[a-zA-Z0-9_-]{6,64}$/;

function assertXhsHost(url: URL, original: string): void {
  const host = url.hostname.toLowerCase();
  if (host !== XHS_HOST_SUFFIX && !host.endsWith(`.${XHS_HOST_SUFFIX}`)) {
    throw new Error(`链接的域名不属于小红书（实际是 "${host}"）：${original}。本工具只处理 xiaohongshu.com 域名下的链接。`);
  }
}

function assertValidId(id: string, kind: "笔记" | "用户", original: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(
      `无法从输入中解析出合法的${kind} ID："${id}"（原始输入：${original}）。` +
        `请传入完整的小红书链接，或者${kind} ID 本身（字母、数字、- 或 _ 组成，长度 6~64）。`,
    );
  }
}

function parseUrlOrThrow(input: string): URL {
  try {
    return new URL(input);
  } catch {
    throw new Error(`不是合法的链接：${input}`);
  }
}

/**
 * 从各种形式的小红书链接/ID 中解析出 noteId 和 xsec_token（部分详情/评论接口需要 token 才能正常返回）。
 * 会校验链接域名确实属于 xiaohongshu.com，并对解析出的 ID 做基本格式校验，
 * 不会把任意网址的最后一段路径当成 noteId。
 */
export function parseNoteRef(input: string): { noteId: string; xsecToken?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("笔记链接/ID 不能为空。");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    assertValidId(trimmed, "笔记", input);
    return { noteId: trimmed };
  }

  const url = parseUrlOrThrow(trimmed);
  assertXhsHost(url, input);

  const segments = url.pathname.split("/").filter(Boolean);
  const noteId = segments[segments.length - 1];
  if (!noteId) {
    throw new Error(`无法从链接中解析出笔记 ID（链接里没有可用的路径片段）：${input}`);
  }
  assertValidId(noteId, "笔记", input);
  const xsecToken = url.searchParams.get("xsec_token") ?? undefined;
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

/**
 * 从各种形式的小红书用户主页链接/ID 中解析出 userId，校验规则与 parseNoteRef 一致。
 */
export function parseUserRef(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("用户链接/ID 不能为空。");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    assertValidId(trimmed, "用户", input);
    return trimmed;
  }

  const url = parseUrlOrThrow(trimmed);
  assertXhsHost(url, input);

  const segments = url.pathname.split("/").filter(Boolean);
  const userId = segments[segments.length - 1];
  if (!userId) {
    throw new Error(`无法从链接中解析出用户 ID（链接里没有可用的路径片段）：${input}`);
  }
  assertValidId(userId, "用户", input);
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

/** 把任意值当作普通对象读取，不是对象（含 null/数组等基础类型不算）时返回 undefined。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
