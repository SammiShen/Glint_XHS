import type { Page } from "playwright";
import { config } from "../config.js";
import { withXhsPage, looksLoggedOut } from "../browser.js";
import {
  buildExploreUrl,
  captureJsonResponse,
  firstDefined,
  getPath,
  parseCount,
  parseNoteRef,
  readInitialState,
} from "./extract.js";
import type { NoteDetail } from "./types.js";
import { log } from "../logger.js";

const FEED_API = "/api/sns/web/v1/feed";

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

/** 兜底方案：接口没抓到时，直接从渲染出的 DOM 文本里抠标题/正文/图片。 */
async function fallbackScrapeDom(page: Page, noteId: string): Promise<NoteDetail> {
  const data = await page.evaluate(() => {
    const title =
      document.querySelector('[class*="title"]')?.textContent?.trim() ??
      document.title?.replace(/[-_].*$/, "").trim();
    const content = document.querySelector('[class*="desc"], [class*="content"]')?.textContent?.trim();
    const images = Array.from(document.querySelectorAll('[class*="image"] img, img'))
      .map((img) => (img as HTMLImageElement).src)
      .filter((src) => src && !src.startsWith("data:"));
    return { title, content, images: Array.from(new Set(images)).slice(0, 20) };
  });

  return {
    noteId,
    url: buildExploreUrl(noteId),
    title: data.title || "(无标题，可能是页面结构变化导致解析失败)",
    content: data.content ?? "",
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
    const response = await captureJsonResponse<{
      data?: { items?: { id?: string; note_card?: Record<string, unknown> }[] };
    }>(page, FEED_API, () =>
      page.goto(url, { timeout: config.navigationTimeoutMs, waitUntil: "domcontentloaded" }),
    );

    const item = response?.data?.items?.find((i) => !i.id || i.id === noteId) ?? response?.data?.items?.[0];
    if (item?.note_card) {
      return normalizeNoteCard(noteId, item.note_card);
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
