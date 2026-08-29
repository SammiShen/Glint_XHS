import type { Page } from "playwright";
import { config } from "../config.js";
import { withXhsPage, looksLoggedOut } from "../browser.js";
import { captureJsonResponse, parseCount, scrollDown, sleep } from "./extract.js";
import type { SearchResultItem } from "./types.js";
import { log } from "../logger.js";

const SEARCH_API = "/api/sns/web/v1/search/notes";

interface RawSearchItem {
  id?: string;
  note_id?: string;
  xsec_token?: string;
  model_type?: string;
  note_card?: {
    type?: string;
    display_title?: string;
    title?: string;
    user?: { user_id?: string; nickname?: string; avatar?: string };
    interact_info?: {
      liked_count?: unknown;
      collected_count?: unknown;
      comment_count?: unknown;
    };
    cover?: { url_default?: string; url_pre?: string; url?: string };
  };
}

interface RawSearchResponse {
  success?: boolean;
  data?: { has_more?: boolean; items?: RawSearchItem[] };
}

function toResultItem(raw: RawSearchItem): SearchResultItem | undefined {
  const noteId = raw.id ?? raw.note_id;
  const card = raw.note_card;
  if (!noteId || !card) return undefined;
  const title = card.display_title || card.title || "(无标题)";
  const xsecToken = raw.xsec_token;
  const url = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
  if (xsecToken) {
    url.searchParams.set("xsec_token", xsecToken);
    url.searchParams.set("xsec_source", "pc_search");
  }
  return {
    noteId,
    url: url.toString(),
    title,
    type: card.type === "video" ? "video" : card.type === "normal" ? "normal" : "unknown",
    author: {
      userId: card.user?.user_id ?? "",
      nickname: card.user?.nickname ?? "未知用户",
      avatar: card.user?.avatar,
    },
    cover: card.cover?.url_default ?? card.cover?.url_pre ?? card.cover?.url,
    likes: parseCount(card.interact_info?.liked_count),
    collects: parseCount(card.interact_info?.collected_count),
    comments: parseCount(card.interact_info?.comment_count),
  };
}

/** 页面结构/接口变化时的兜底方案：直接从渲染出的 DOM 里抓标题和链接。 */
async function fallbackScrapeDom(page: Page): Promise<SearchResultItem[]> {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/explore/"]'));
    const seen = new Set<string>();
    const items: {
      noteId: string;
      url: string;
      title: string;
      type: "unknown";
      author: { userId: string; nickname: string };
    }[] = [];
    for (const a of anchors) {
      const href = (a as HTMLAnchorElement).href;
      const match = href.match(/\/explore\/([a-f0-9]+)/i);
      if (!match || seen.has(match[1])) continue;
      const title = a.textContent?.trim();
      if (!title) continue;
      seen.add(match[1]);
      items.push({
        noteId: match[1],
        url: href,
        title,
        type: "unknown",
        author: { userId: "", nickname: "" },
      });
    }
    return items;
  });
}

export async function searchNotes(keyword: string, limit = 20): Promise<SearchResultItem[]> {
  const cappedLimit = Math.min(Math.max(limit, 1), 60);

  return withXhsPage(async (page) => {
    const collected = new Map<string, SearchResultItem>();
    const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(
      keyword,
    )}&source=web_explore_feed`;

    const firstBatch = await captureJsonResponse<RawSearchResponse>(page, SEARCH_API, () =>
      page.goto(searchUrl, { timeout: config.navigationTimeoutMs, waitUntil: "domcontentloaded" }),
    );

    let hasMore = firstBatch?.data?.has_more ?? false;
    for (const raw of firstBatch?.data?.items ?? []) {
      const item = toResultItem(raw);
      if (item) collected.set(item.noteId, item);
    }

    let rounds = 0;
    while (collected.size < cappedLimit && hasMore && rounds < config.maxScrollRounds) {
      rounds += 1;
      const before = collected.size;
      const next = await captureJsonResponse<RawSearchResponse>(page, SEARCH_API, () => scrollDown(page));
      hasMore = next?.data?.has_more ?? false;
      for (const raw of next?.data?.items ?? []) {
        const item = toResultItem(raw);
        if (item) collected.set(item.noteId, item);
      }
      if (collected.size === before) {
        // 这一轮没有拿到新数据，多半是接口没有触发或已经到底了，避免空转。
        break;
      }
      await sleep(300);
    }

    if (collected.size === 0) {
      log(`搜索接口未返回可解析的数据（关键词："${keyword}"），尝试从页面 DOM 兜底抓取`);
      const loggedOut = await looksLoggedOut(page);
      const fallback = await fallbackScrapeDom(page);
      for (const item of fallback) {
        collected.set(item.noteId, item as SearchResultItem);
      }
      if (collected.size === 0) {
        throw new Error(
          loggedOut
            ? "搜索结果为空，且页面上检测到'登录'按钮，请先在被连接的浏览器里登录小红书账号。"
            : "搜索结果为空。可能是小红书页面结构发生了变化，也可能是关键词本身无结果，建议在浏览器里手动打开该搜索链接确认。",
        );
      }
    }

    return Array.from(collected.values()).slice(0, cappedLimit);
  });
}
