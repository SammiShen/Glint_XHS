import type { Page } from "playwright";
import { config } from "../config.js";
import { withXhsPage, looksLoggedOut } from "../browser.js";
import {
  asRecord,
  buildExploreUrl,
  collectXhsResponses,
  firstDefined,
  getPath,
  isXhsHost,
  parseCount,
  parseNoteRef,
  pickContentCandidate,
  pickTitleCandidate,
  readInitialState,
  sleep,
  type CapturedResponse,
  type DomTextCandidate,
} from "./extract.js";
import type { NoteDetail } from "./types.js";
import { log } from "../logger.js";

/**
 * 曾经观察到的详情接口路径，仅用于日志标注"是否命中已知路径"，
 * 实际抓取不再依赖这个精确路径匹配——见 getNoteDetail 里的 collectXhsResponses 调用，
 * 只要响应属于 xiaohongshu.com 且 URL 里带着这条笔记的 noteId，或者路径里含 "feed"，就会被捕获。
 */
const KNOWN_FEED_API = "/api/sns/web/v1/feed";

/**
 * 小红书笔记数据在"搜索接口响应""笔记详情接口响应""__INITIAL_STATE__"三处出现时，
 * 字段命名风格并不完全一致（snake_case 的原始接口 vs camelCase 的前端 store）。
 * 这里对同一份数据统一用宽松的方式取值，任意一种缺失都不影响其它字段的解析。
 */
function normalizeNoteCard(noteId: string, card: Record<string, unknown>): NoteDetail {
  const user = (card.user ?? {}) as Record<string, unknown>;
  const interact = (firstDefined(card.interact_info, card.interactInfo) ?? {}) as Record<string, unknown>;
  const imageList = (firstDefined(card.image_list, card.imageList) ?? []) as Record<string, unknown>[];
  const tagList = (firstDefined(card.tag_list, card.tagList) ?? []) as Record<string, unknown>[];
  const video = firstDefined(card.video, undefined) as Record<string, unknown> | undefined;
  const videoUrl = getPath(video, ["media", "stream", "h264", 0, "master_url"]) as string | undefined;

  const images = imageList
    .map((img) => firstDefined(img.url_default, img.urlDefault, img.url) as string | undefined)
    .filter((v): v is string => Boolean(v));

  const tags = tagList
    .map((t) => firstDefined(t.name, t.id) as string | undefined)
    .filter((v): v is string => Boolean(v));

  const type = firstDefined(card.type, "unknown") as string;

  return {
    noteId,
    url: buildExploreUrl(noteId),
    title: (firstDefined(card.title, "") as string) || "(无标题)",
    content: (firstDefined(card.desc, card.description, "") as string) ?? "",
    type: type === "video" ? "video" : type === "normal" ? "normal" : "unknown",
    author: {
      userId: (firstDefined(user.user_id, user.userId, "") as string) ?? "",
      nickname: (firstDefined(user.nickname, "未知用户") as string) ?? "未知用户",
      avatar: firstDefined(user.avatar, user.image) as string | undefined,
    },
    publishedAt: normalizeTime(firstDefined(card.time, card.publishTime)),
    images,
    video: videoUrl,
    tags,
    likes: parseCount(interact.liked_count ?? interact.likedCount),
    collects: parseCount(interact.collected_count ?? interact.collectedCount),
    comments: parseCount(interact.comment_count ?? interact.commentCount),
  };
}

function normalizeTime(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const num = Number(raw);
  if (Number.isNaN(num)) return String(raw);
  // 小红书时间戳可能是秒或毫秒，统一按毫秒/秒粗略判断。
  const ms = num > 1e12 ? num : num * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? String(raw) : date.toISOString();
}

/**
 * 从任意形状的详情接口响应里找出这条笔记的"卡片"对象，兼容几种常见的顶层结构：
 * data.items[].note_card/noteCard/card、data.items[] 本身被拍平、data.note、
 * 甚至 data 本身就是卡片。找到 items 数组时优先匹配 noteId 对应的那一条。
 */
function extractNoteCardFromResponse(json: unknown, noteId: string): Record<string, unknown> | undefined {
  const root = asRecord(json);
  if (!root) return undefined;
  const data = asRecord(root.data) ?? root;

  const items = data.items;
  if (Array.isArray(items)) {
    const records = items.map((it) => asRecord(it)).filter((it): it is Record<string, unknown> => Boolean(it));
    const matched =
      records.find((it) => {
        const id = firstDefined(it.id, it.note_id, it.noteId);
        return id === noteId;
      }) ?? records[0];
    if (matched) {
      const card = asRecord(firstDefined(matched.note_card, matched.noteCard, matched.card));
      if (card) return card;
      // 有些形状里条目本身就是卡片，没有额外包一层——用是否带笔记特征字段来判断。
      if (firstDefined(matched.desc, matched.title, matched.interact_info, matched.interactInfo) !== undefined) {
        return matched;
      }
    }
  }

  const directNote = asRecord(firstDefined(data.note, root.note));
  if (directNote) return directNote;

  if (firstDefined(data.desc, data.title, data.interact_info, data.interactInfo) !== undefined) {
    return data;
  }
  return undefined;
}

function logResponseDiagnostics(candidate: CapturedResponse, noteId: string): void {
  const topKeys = candidate.json !== undefined ? Object.keys(asRecord(candidate.json) ?? {}) : [];
  const dataObj = candidate.json !== undefined ? asRecord(asRecord(candidate.json)?.data) : undefined;
  const card = candidate.json !== undefined ? extractNoteCardFromResponse(candidate.json, noteId) : undefined;
  log(
    "[note-detail-diagnostics] response",
    `url=${candidate.url}`,
    `status=${candidate.status}`,
    `matchedKnownEndpoint=${candidate.url.includes(KNOWN_FEED_API)}`,
    candidate.jsonError ? `jsonError=${candidate.jsonError}` : "",
    `topKeys=[${topKeys.join(",")}]`,
    `dataKeys=[${dataObj ? Object.keys(dataObj).join(",") : ""}]`,
    `cardFound=${Boolean(card)}`,
    `cardKeys=[${card ? Object.keys(card).join(",") : ""}]`,
  );
}

interface DomHarvest {
  titleCandidates: DomTextCandidate[];
  contentCandidates: DomTextCandidate[];
  images: string[];
  documentTitle: string;
}

/**
 * 兜底方案：接口/__INITIAL_STATE__ 都没拿到数据时，直接从渲染出的 DOM 里找标题/正文。
 *
 * 之前的实现用 `document.querySelector('[class*="desc"], [class*="content"]')` 直接取
 * DOM 里第一个匹配的元素——这类通配 class 选择器很容易先命中页面外层的导航栏/侧边栏容器
 * （典型症状：不管传入哪条笔记 URL，抓到的都是同一段固定的导航栏文案）。
 * 这里改成先收集所有候选元素，排除掉位于 nav/header/aside/footer 等容器里的、
 * 以及内部链接数偏多（导航菜单特征）的候选，正文候选再按文本长度取最长的一个。
 */
async function fallbackScrapeDom(page: Page, noteId: string): Promise<NoteDetail> {
  await page
    .waitForSelector('[class*="desc" i], [class*="content" i], [class*="note-text" i]', { timeout: 3000 })
    .catch(() => undefined);

  const data: DomHarvest = await page.evaluate(() => {
    function isChrome(el: Element): boolean {
      return Boolean(
        el.closest(
          'nav, header, aside, footer, [class*="nav" i], [class*="sidebar" i], [class*="menu" i], ' +
            '[class*="header" i], [class*="footer" i], [class*="toolbar" i]',
        ),
      );
    }
    function harvest(selector: string) {
      return Array.from(document.querySelectorAll(selector)).map((el) => ({
        text: (el.textContent || "").trim(),
        isChrome: isChrome(el),
        anchorCount: el.querySelectorAll("a").length,
      }));
    }

    const titleCandidates = harvest('[class*="title" i], [id*="title" i]');
    const contentCandidates = harvest('[class*="desc" i], [class*="content" i], [class*="note-text" i], [id*="desc" i]');
    const images = Array.from(document.querySelectorAll('[class*="image" i] img, img'))
      .map((img) => (img as HTMLImageElement).src)
      .filter((src) => src && !src.startsWith("data:"));

    return {
      titleCandidates,
      contentCandidates,
      images: Array.from(new Set(images)).slice(0, 20),
      documentTitle: document.title ?? "",
    };
  });

  log(
    "[note-detail-diagnostics] dom",
    `titleCandidates=${data.titleCandidates.length}`,
    `contentCandidates=${data.contentCandidates.length}`,
    `usableContentCandidates=${data.contentCandidates.filter((c) => !c.isChrome && c.anchorCount <= 2 && c.text.length >= 20).length}`,
  );

  const content = pickContentCandidate(data.contentCandidates);
  const title = pickTitleCandidate(data.titleCandidates) ?? data.documentTitle.replace(/[-_].*$/, "").trim();

  return {
    noteId,
    url: buildExploreUrl(noteId),
    title: title || "(无标题，可能是页面结构变化导致解析失败)",
    content: content ?? "",
    type: "unknown",
    author: { userId: "", nickname: "未知用户" },
    images: data.images,
    tags: [],
  };
}

export async function getNoteDetail(ref: string): Promise<NoteDetail> {
  const { noteId, xsecToken } = parseNoteRef(ref);
  const url = buildExploreUrl(noteId, xsecToken);

  return withXhsPage(async (page) => {
    // 不再只等一个硬编码 endpoint：持续监听"域名属于 xiaohongshu.com 且（URL 带着这条笔记的
    // noteId，或者路径里含 feed）"的响应，这样接口改名/换路径时也还能捕获到。
    const collector = collectXhsResponses(page, (u) => isXhsHost(u) && (u.includes(noteId) || /feed/i.test(u)));
    try {
      await page.goto(url, { timeout: config.navigationTimeoutMs, waitUntil: "domcontentloaded" });
      await sleep(500);
      await collector.waitForPending();
    } finally {
      collector.stop();
    }

    log(`[note-detail-diagnostics] page url=${page.url()} title="${await page.title().catch(() => "")}"`);
    for (const candidate of collector.candidates) {
      logResponseDiagnostics(candidate, noteId);
    }

    for (const candidate of collector.candidates) {
      if (candidate.json === undefined) continue;
      const card = extractNoteCardFromResponse(candidate.json, noteId);
      if (card) {
        return normalizeNoteCard(noteId, card);
      }
    }

    log(`详情接口未返回可解析数据（noteId=${noteId}），尝试 __INITIAL_STATE__`);
    const state = await readInitialState<Record<string, unknown>>(page);
    const noteDetailMap = getPath(state, ["note", "noteDetailMap", noteId, "note"]) as
      | Record<string, unknown>
      | undefined;
    if (noteDetailMap) {
      return normalizeNoteCard(noteId, noteDetailMap);
    }

    log(`__INITIAL_STATE__ 也未找到笔记数据（noteId=${noteId}），退回 DOM 兜底抓取`);
    const loggedOut = await looksLoggedOut(page);
    if (loggedOut) {
      throw new Error("页面上检测到'登录'按钮，请先在被连接的浏览器里登录小红书账号后重试。");
    }
    return fallbackScrapeDom(page, noteId);
  });
}

/** 仅供单元测试访问内部纯函数，不作为对外 API。 */
export const __testables = { extractNoteCardFromResponse, normalizeNoteCard };
