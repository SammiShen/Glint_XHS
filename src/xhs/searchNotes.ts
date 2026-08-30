import type { Page, Response } from "playwright";
import { config } from "../config.js";
import { withXhsPage, looksLoggedOut } from "../browser.js";
import { asRecord, firstDefined, parseCount, scrollDown, sleep } from "./extract.js";
import type { SearchResultItem } from "./types.js";
import { log } from "../logger.js";

/**
 * 曾经观察到的搜索接口路径，仅用于日志标注"是否命中已知路径"，
 * 实际抓取不再依赖这个精确路径匹配（见 collectXhsSearchResponses）。
 */
const KNOWN_SEARCH_API = "/api/sns/web/v1/search/notes";

interface CapturedResponse {
  url: string;
  status: number;
  json?: unknown;
  jsonError?: string;
}

/**
 * 不再只等待一个硬编码 endpoint 的响应，而是在整次搜索期间持续监听所有
 * "域名属于 xiaohongshu.com 且 URL 包含 search"的响应，记录下来供诊断和解析。
 * 这样即使小红书把接口路径从 KNOWN_SEARCH_API 换成别的名字，也还能捕获到。
 */
function collectXhsSearchResponses(page: Page): {
  candidates: CapturedResponse[];
  waitForPending: () => Promise<void>;
  stop: () => void;
} {
  const candidates: CapturedResponse[] = [];
  const pending: Promise<void>[] = [];
  const handler = (res: Response) => {
    let host: string;
    try {
      host = new URL(res.url()).hostname;
    } catch {
      return;
    }
    if (!host.endsWith("xiaohongshu.com")) return;
    if (!/search/i.test(res.url())) return;

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

/** 从任意形状的响应 JSON 里找"结果条目数组"，兼容几种常见的顶层字段命名。 */
function extractItemsArray(json: unknown): unknown[] {
  const root = asRecord(json);
  if (!root) return [];
  const data = asRecord(root.data) ?? root;
  const candidates = [data.items, data.notes, root.items, root.notes];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * 把一条结果条目（不管来自 note_card/noteCard/card 包裹，还是被拍平在条目本身上）
 * 转成统一的 SearchResultItem。兼容 snake_case / camelCase 字段命名。
 * 只要求能解析出 noteId；其它字段（标题、作者、互动数）缺失时用合理默认值兜底，
 * 不会因为某个可选字段缺失就整条丢弃。
 */
function toResultItem(rawItem: unknown): SearchResultItem | undefined {
  const item = asRecord(rawItem);
  if (!item) return undefined;
  const card = asRecord(firstDefined(item.note_card, item.noteCard, item.card)) ?? item;

  const noteIdRaw = firstDefined(item.id, item.note_id, item.noteId, card.id, card.note_id, card.noteId);
  const noteId = typeof noteIdRaw === "string" && noteIdRaw ? noteIdRaw : undefined;
  if (!noteId) return undefined;

  const xsecToken = firstDefined(item.xsec_token, item.xsecToken, card.xsec_token, card.xsecToken);
  const url = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
  if (typeof xsecToken === "string" && xsecToken) {
    url.searchParams.set("xsec_token", xsecToken);
    url.searchParams.set("xsec_source", "pc_search");
  }

  const title = firstDefined(card.display_title, card.displayTitle, card.title, item.title);
  const userObj = asRecord(firstDefined(card.user, card.author, item.user)) ?? {};
  const interact =
    asRecord(firstDefined(card.interact_info, card.interactInfo, item.interact_info, item.interactInfo)) ?? {};
  const coverObj = asRecord(firstDefined(card.cover, item.cover)) ?? {};
  const type = firstDefined(card.type, item.type);

  return {
    noteId,
    url: url.toString(),
    title: (typeof title === "string" && title) || "(无标题)",
    type: type === "video" ? "video" : type === "normal" ? "normal" : "unknown",
    author: {
      userId: (firstDefined(userObj.user_id, userObj.userId) as string | undefined) ?? "",
      nickname: (firstDefined(userObj.nickname) as string | undefined) ?? "未知用户",
      avatar: firstDefined(userObj.avatar, userObj.image) as string | undefined,
    },
    cover: firstDefined(
      coverObj.url_default,
      coverObj.urlDefault,
      coverObj.url_pre,
      coverObj.urlPre,
      coverObj.url,
    ) as string | undefined,
    likes: parseCount(firstDefined(interact.liked_count, interact.likedCount)),
    collects: parseCount(firstDefined(interact.collected_count, interact.collectedCount)),
    comments: parseCount(firstDefined(interact.comment_count, interact.commentCount)),
  };
}

function reparseCollected(candidates: CapturedResponse[], collected: Map<string, SearchResultItem>): void {
  for (const candidate of candidates) {
    if (candidate.json === undefined) continue;
    for (const rawItem of extractItemsArray(candidate.json)) {
      const item = toResultItem(rawItem);
      if (item) collected.set(item.noteId, item);
    }
  }
}

/** 只输出结构/数量/字段名，绝不输出笔记正文、cookie 或 token 这类内容。 */
function logCandidateDiagnostics(candidate: CapturedResponse): void {
  const topKeys = candidate.json !== undefined ? Object.keys(asRecord(candidate.json) ?? {}) : [];
  const dataObj = candidate.json !== undefined ? asRecord(asRecord(candidate.json)?.data) : undefined;
  const dataKeys = dataObj ? Object.keys(dataObj) : [];
  const items = candidate.json !== undefined ? extractItemsArray(candidate.json) : [];
  const firstItem = asRecord(items[0]);
  const firstCard = firstItem ? asRecord(firstDefined(firstItem.note_card, firstItem.noteCard, firstItem.card)) : undefined;

  log(
    "[search-diagnostics] response",
    `url=${candidate.url}`,
    `status=${candidate.status}`,
    `matchedKnownEndpoint=${candidate.url.includes(KNOWN_SEARCH_API)}`,
    candidate.jsonError ? `jsonError=${candidate.jsonError}` : "",
    `topKeys=[${topKeys.join(",")}]`,
    `dataKeys=[${dataKeys.join(",")}]`,
    `itemsPresent=${Array.isArray(dataObj?.items) || Array.isArray(dataObj?.notes)}`,
    `itemsLength=${items.length}`,
    `firstItemKeys=[${firstItem ? Object.keys(firstItem).join(",") : ""}]`,
    `firstCardKeys=[${firstCard ? Object.keys(firstCard).join(",") : ""}]`,
  );
}

async function logPageDiagnostics(page: Page): Promise<void> {
  const url = page.url();
  const title = await page.title().catch(() => "(无法获取 title)");
  log(`[search-diagnostics] page url=${url} title="${title}"`);
}

/** 关键词/正文都是最好别永久落盘的用户输入内容相关信息，这里只做粗粒度、关键词命中式的检测。 */
async function detectRiskControl(page: Page): Promise<string | undefined> {
  return page
    .evaluate(() => {
      const bodyText = document.body?.innerText ?? "";
      const markers = ["安全验证", "验证码", "拖动滑块", "请完成验证", "captcha", "网络异常，请稍后再试"];
      return markers.find((marker) => bodyText.includes(marker));
    })
    .catch(() => undefined);
}

interface DomFallbackResult {
  items: SearchResultItem[];
  exploreAnchorCount: number;
  discoveryAnchorCount: number;
  cardCount: number;
}

/**
 * 接口解析拿不到结果时的兜底：直接从渲染出的 DOM 里找笔记链接。
 * 不再要求 anchor 本身要有非空文本才算数——只要能从 href 里解析出 noteId，
 * 就返回一条结果（标题拿不到时用 "(无标题)"），避免"标题选择器一失效就整条丢弃"。
 */
async function fallbackScrapeDom(page: Page): Promise<DomFallbackResult> {
  // 给搜索结果的异步渲染留一点时间；等不到也不阻塞整体流程，只是继续用当前 DOM 状态兜底。
  await Promise.race([
    page
      .waitForSelector('a[href*="/explore/"], a[href*="/discovery/item/"]', { timeout: 3000 })
      .catch(() => undefined),
    sleep(3000),
  ]);

  return page.evaluate(() => {
    function pickTitle(anchor: Element): string | undefined {
      const ariaLabel = anchor.getAttribute("aria-label")?.trim();
      if (ariaLabel) return ariaLabel;
      const ownText = anchor.textContent?.trim();
      if (ownText) return ownText;
      const titleInside = anchor.querySelector('[class*="title" i]')?.textContent?.trim();
      if (titleInside) return titleInside;
      const card = anchor.closest('section, article, li, [class*="note" i], [class*="card" i]');
      const titleInCard = card?.querySelector('[class*="title" i]')?.textContent?.trim();
      if (titleInCard) return titleInCard;
      return undefined;
    }

    const exploreAnchors = Array.from(document.querySelectorAll('a[href*="/explore/"]'));
    const discoveryAnchors = Array.from(document.querySelectorAll('a[href*="/discovery/item/"]'));
    const allAnchors = [...exploreAnchors, ...discoveryAnchors];
    const seen = new Set<string>();
    const items: {
      noteId: string;
      url: string;
      title: string;
      type: "unknown";
      author: { userId: string; nickname: string };
    }[] = [];
    for (const a of allAnchors) {
      const href = (a as HTMLAnchorElement).href;
      const match = href.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9_-]+)/);
      if (!match || seen.has(match[1])) continue;
      seen.add(match[1]);
      items.push({
        noteId: match[1],
        url: href,
        title: pickTitle(a) ?? "(无标题)",
        type: "unknown",
        author: { userId: "", nickname: "" },
      });
    }

    const cardCount = document.querySelectorAll(
      '[class*="note-item" i], [class*="noteitem" i], section[class*="note" i], [class*="feeds" i] > div',
    ).length;

    return {
      items,
      exploreAnchorCount: exploreAnchors.length,
      discoveryAnchorCount: discoveryAnchors.length,
      cardCount,
    };
  });
}

export async function searchNotes(keyword: string, limit = 20): Promise<SearchResultItem[]> {
  const cappedLimit = Math.min(Math.max(limit, 1), 60);

  return withXhsPage(async (page) => {
    const collector = collectXhsSearchResponses(page);
    const collected = new Map<string, SearchResultItem>();

    try {
      const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(
        keyword,
      )}&source=web_explore_feed`;
      await page.goto(searchUrl, { timeout: config.navigationTimeoutMs, waitUntil: "domcontentloaded" });
      await sleep(500);
      await collector.waitForPending();
      reparseCollected(collector.candidates, collected);

      let rounds = 0;
      while (collected.size < cappedLimit && rounds < config.maxScrollRounds) {
        rounds += 1;
        const before = collector.candidates.length;
        await scrollDown(page);
        await sleep(700);
        await collector.waitForPending();
        reparseCollected(collector.candidates, collected);
        if (collector.candidates.length === before) {
          // 这一轮没有捕获到任何新响应，多半已经到底或者接口没有再触发，避免空转。
          break;
        }
      }
    } finally {
      collector.stop();
    }

    await logPageDiagnostics(page);
    for (const candidate of collector.candidates) {
      logCandidateDiagnostics(candidate);
    }

    if (collected.size > 0) {
      return Array.from(collected.values()).slice(0, cappedLimit);
    }

    // ---- 接口解析一条结果都没拿到，尝试 DOM 兜底 ----
    const domResult = await fallbackScrapeDom(page);
    log(
      "[search-diagnostics] dom",
      `exploreAnchorCount=${domResult.exploreAnchorCount}`,
      `discoveryAnchorCount=${domResult.discoveryAnchorCount}`,
      `cardCount=${domResult.cardCount}`,
      `parsedItems=${domResult.items.length}`,
    );
    for (const item of domResult.items) {
      collected.set(item.noteId, item);
    }

    if (collected.size > 0) {
      return Array.from(collected.values()).slice(0, cappedLimit);
    }

    // ---- DOM 兜底也没有结果，开始分类诊断，不再统一归为"可能页面结构变化" ----
    const risk = await detectRiskControl(page);
    if (risk) {
      throw new Error(
        `[D] 页面出现风控/验证提示（命中关键词特征："${risk}"），需要你在被连接的浏览器窗口里手动处理` +
          "（完成验证/滑块等），然后重试。",
      );
    }

    const loggedOut = await looksLoggedOut(page);
    if (loggedOut) {
      throw new Error("[D] 页面上检测到「登录」按钮，请先在被连接的浏览器里登录小红书账号，然后重试。");
    }

    if (collector.candidates.length === 0) {
      throw new Error(
        `[C] 未捕获到任何疑似搜索接口的响应（域名属于 xiaohongshu.com 且 URL 包含 "search"）。` +
          "可能接口路径已经变化，需要打开浏览器开发者工具的 Network 面板确认真实的搜索接口路径。" +
          `当前页面：${page.url()}`,
      );
    }

    const parsedCandidates = collector.candidates.filter((c) => c.json !== undefined);
    if (parsedCandidates.length === 0) {
      throw new Error(
        `[C] 捕获到 ${collector.candidates.length} 个疑似搜索响应，但没有一个能解析为 JSON` +
          "（可能是非 JSON 响应，或响应体读取失败），详见服务端诊断日志。",
      );
    }

    const anyItemsPresent = parsedCandidates.some((c) => extractItemsArray(c.json).length > 0);
    if (anyItemsPresent) {
      throw new Error(
        "[B] 搜索接口返回了结果条目，但解析器未能从任何一条里提取到笔记 ID，请查看服务端诊断日志确认字段结构。",
      );
    }

    if (domResult.exploreAnchorCount > 0 || domResult.discoveryAnchorCount > 0 || domResult.cardCount > 0) {
      throw new Error(
        `[B] 搜索结果在页面上可能存在（DOM 里 /explore/ 链接数=${domResult.exploreAnchorCount}，` +
          `/discovery/item/ 链接数=${domResult.discoveryAnchorCount}，疑似卡片数=${domResult.cardCount}），` +
          "但接口响应里没有可用数据，且从这些链接里也没能提取到合法的笔记 ID，" +
          "说明当前 DOM/接口解析逻辑都需要更新，请查看服务端诊断日志确认真实结构。",
      );
    }

    throw new Error(`[A] 小红书搜索接口明确返回了 0 条结果（关键词："${keyword}"）。`);
  });
}

/** 仅供单元测试访问内部纯函数，不作为对外 API。 */
export const __testables = { extractItemsArray, toResultItem };
