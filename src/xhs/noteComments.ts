import { config } from "../config.js";
import { withXhsPage, looksLoggedOut } from "../browser.js";
import {
  buildExploreUrl,
  collectJsonResponses,
  firstDefined,
  parseCount,
  parseNoteRef,
  scrollDown,
  sleep,
} from "./extract.js";
import type { NoteComment } from "./types.js";
import { log } from "../logger.js";

const COMMENT_API = "/api/sns/web/v2/comment/page";

interface RawComment {
  id?: string;
  content?: string;
  like_count?: unknown;
  likeCount?: unknown;
  create_time?: unknown;
  createTime?: unknown;
  user_info?: Record<string, unknown>;
  userInfo?: Record<string, unknown>;
  sub_comments?: RawComment[];
  subComments?: RawComment[];
}

interface RawCommentResponse {
  data?: { has_more?: boolean; comments?: RawComment[] };
}

function normalizeTime(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const num = Number(raw);
  if (Number.isNaN(num)) return undefined;
  const ms = num > 1e12 ? num : num * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeComment(raw: RawComment, parentCommentId?: string): NoteComment | undefined {
  const id = raw.id;
  if (!id) return undefined;
  const user = (firstDefined(raw.user_info, raw.userInfo) ?? {}) as Record<string, unknown>;
  const subComments = (firstDefined(raw.sub_comments, raw.subComments) ?? []) as RawComment[];
  return {
    commentId: id,
    content: raw.content ?? "",
    likes: parseCount(firstDefined(raw.like_count, raw.likeCount)) ?? 0,
    createdAt: normalizeTime(firstDefined(raw.create_time, raw.createTime)),
    author: {
      userId: (firstDefined(user.user_id, user.userId, "") as string) ?? "",
      nickname: (firstDefined(user.nickname, "未知用户") as string) ?? "未知用户",
      avatar: firstDefined(user.image, user.avatar) as string | undefined,
    },
    parentCommentId,
    replies: subComments
      .map((c) => normalizeComment(c, id))
      .filter((c): c is NoteComment => Boolean(c)),
  };
}

export async function getNoteComments(ref: string, limit = 30): Promise<NoteComment[]> {
  const { noteId, xsecToken } = parseNoteRef(ref);
  const url = buildExploreUrl(noteId, xsecToken);
  const cappedLimit = Math.min(Math.max(limit, 1), 200);

  return withXhsPage(async (page) => {
    const { results, stop } = collectJsonResponses<RawCommentResponse>(page, COMMENT_API);
    try {
      await page.goto(url, { timeout: config.navigationTimeoutMs, waitUntil: "domcontentloaded" });
      await sleep(1000);

      let rounds = 0;
      let lastCount = 0;
      while (rounds < config.maxScrollRounds) {
        rounds += 1;
        await scrollDown(page);
        await sleep(800);
        const current = results.reduce((sum, r) => sum + (r.data?.comments?.length ?? 0), 0);
        if (current >= cappedLimit || current === lastCount) break;
        lastCount = current;
      }
    } finally {
      stop();
    }

    const seen = new Map<string, NoteComment>();
    for (const res of results) {
      for (const raw of res.data?.comments ?? []) {
        const comment = normalizeComment(raw);
        if (comment) seen.set(comment.commentId, comment);
      }
    }

    if (seen.size === 0) {
      log(`评论接口未返回可解析数据（noteId=${noteId}）`);
      const loggedOut = await looksLoggedOut(page);
      throw new Error(
        loggedOut
          ? "评论列表为空，且页面上检测到'登录'按钮，请先在被连接的浏览器里登录小红书账号。"
          : "评论列表为空。可能这篇笔记确实没有评论，也可能是页面结构发生了变化，建议在浏览器里手动确认。",
      );
    }

    const flat = Array.from(seen.values());
    // 按顶层评论截断到 limit，保留每条顶层评论下的全部回复，避免把一条评论的回复从中间截断。
    let total = 0;
    const output: NoteComment[] = [];
    for (const c of flat) {
      if (total >= cappedLimit) break;
      output.push(c);
      total += 1 + (c.replies?.length ?? 0);
    }
    return output;
  });
}
