import type { Page, Response } from "playwright";

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

export function isXhsHost(urlStr: string): boolean {
  try {
    return new URL(urlStr).hostname.toLowerCase().endsWith(XHS_HOST_SUFFIX);
  } catch {
    return false;
  }
}

export interface CapturedResponse {
  url: string;
  status: number;
  json?: unknown;
  jsonError?: string;
}

/**
 * 在整个操作期间持续监听匹配 predicate 的响应，而不是只等第一个就返回——
 * 既能在诊断日志里看到"实际命中了哪些接口"，也不会因为接口路径改名就完全捕获不到。
 * 调用方需要在自己认为"该收的都收到了"之后调用 waitForPending() 确保异步的
 * response.json() 都已经落地，再读取 candidates。
 */
export function collectXhsResponses(
  page: Page,
  predicate: (url: string) => boolean,
): { candidates: CapturedResponse[]; waitForPending: () => Promise<void>; stop: () => void } {
  const candidates: CapturedResponse[] = [];
  const pending: Promise<void>[] = [];
  const handler = (res: Response) => {
    if (!predicate(res.url())) return;
    const entry: CapturedResponse = { url: res.url(), status: res.status() };
    candidates.push(entry);
    pending.push(
      res
        .json()
        .then((json) => {
          entry.json = json;
        })
        .catch((err) => {
          entry.jsonError = err instanceof Error ? err.message : String(err);
        }),
    );
  };
  page.on("response", handler);
  return {
    candidates,
    waitForPending: () => Promise.all(pending).then(() => undefined),
    stop: () => page.off("response", handler),
  };
}

/** DOM 里挖出来的一个"可能是标题/正文"的候选文本，带一些用于排除导航栏等 UI 元素的元信息。 */
export interface DomTextCandidate {
  text: string;
  isChrome: boolean;
  anchorCount: number;
}

const MIN_CONTENT_LENGTH = 20;
const MAX_CANDIDATE_ANCHORS = 2;

/**
 * 从若干候选文本里挑正文：排除位于 nav/header/aside/footer 等导航型容器里的候选、
 * 排除内部链接数偏多（典型导航菜单特征）的候选，剩下的按文本长度取最长的一个——
 * 真实笔记正文几乎总是比任何一条导航栏文案长得多，这比"选第一个匹配的元素"稳健得多。
 */
export function pickContentCandidate(candidates: DomTextCandidate[]): string | undefined {
  const usable = candidates.filter(
    (c) => !c.isChrome && c.anchorCount <= MAX_CANDIDATE_ANCHORS && c.text.length >= MIN_CONTENT_LENGTH,
  );
  if (usable.length === 0) return undefined;
  return usable.reduce((best, cur) => (cur.text.length > best.text.length ? cur : best)).text;
}

/** 标题候选比正文候选短得多，"取最长"这个信号不适用，只做导航栏排除后取第一个。 */
export function pickTitleCandidate(candidates: DomTextCandidate[]): string | undefined {
  const usable = candidates.find(
    (c) => !c.isChrome && c.anchorCount <= MAX_CANDIDATE_ANCHORS && c.text.length > 0,
  );
  return usable?.text;
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
