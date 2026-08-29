import { config } from "../config.js";
import { withXhsPage, looksLoggedOut } from "../browser.js";
import { collectJsonResponses, firstDefined, parseCount, parseUserRef, scrollDown, sleep } from "./extract.js";
import type { SearchResultItem, UserProfile } from "./types.js";
import { log } from "../logger.js";

const PROFILE_API = "/api/sns/web/v1/user/otherinfo";
const POSTED_API = "/api/sns/web/v1/user_posted";

interface RawProfileResponse {
  data?: {
    basic_info?: { nickname?: string; images?: string; desc?: string };
    interactions?: { type?: string; count?: unknown }[];
  };
}

interface RawPostedNote {
  note_id?: string;
  id?: string;
  display_title?: string;
  title?: string;
  type?: string;
  cover?: { url_default?: string; url_pre?: string; url?: string };
  user?: { user_id?: string; nickname?: string; avatar?: string };
  interact_info?: { liked_count?: unknown; collected_count?: unknown; comment_count?: unknown };
}

interface RawPostedResponse {
  data?: { has_more?: boolean; notes?: RawPostedNote[] };
}

function toResultItem(userId: string, nickname: string, raw: RawPostedNote): SearchResultItem | undefined {
  const noteId = raw.note_id ?? raw.id;
  if (!noteId) return undefined;
  return {
    noteId,
    url: `https://www.xiaohongshu.com/explore/${noteId}`,
    title: raw.display_title || raw.title || "(无标题)",
    type: raw.type === "video" ? "video" : raw.type === "normal" ? "normal" : "unknown",
    author: {
      userId: raw.user?.user_id ?? userId,
      nickname: raw.user?.nickname ?? nickname,
      avatar: raw.user?.avatar,
    },
    cover: raw.cover?.url_default ?? raw.cover?.url_pre ?? raw.cover?.url,
    likes: parseCount(raw.interact_info?.liked_count),
    collects: parseCount(raw.interact_info?.collected_count),
    comments: parseCount(raw.interact_info?.comment_count),
  };
}

export async function getUserProfile(ref: string, notesLimit = 20): Promise<UserProfile> {
  const userId = parseUserRef(ref);
  const cappedLimit = Math.min(Math.max(notesLimit, 1), 60);

  return withXhsPage(async (page) => {
    const profileWaiter = collectJsonResponses<RawProfileResponse>(page, PROFILE_API);
    const postedWaiter = collectJsonResponses<RawPostedResponse>(page, POSTED_API);
    try {
      await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`, {
        timeout: config.navigationTimeoutMs,
        waitUntil: "domcontentloaded",
      });
      await sleep(1200);

      let rounds = 0;
      let lastCount = 0;
      while (rounds < config.maxScrollRounds) {
        rounds += 1;
        const total = postedWaiter.results.reduce((sum, r) => sum + (r.data?.notes?.length ?? 0), 0);
        if (total >= cappedLimit) break;
        await scrollDown(page);
        await sleep(800);
        if (total === lastCount) break;
        lastCount = total;
      }
    } finally {
      profileWaiter.stop();
      postedWaiter.stop();
    }

    const basicInfo = profileWaiter.results[0]?.data?.basic_info;
    const interactions = profileWaiter.results[0]?.data?.interactions ?? [];
    const findInteraction = (type: string) =>
      parseCount(interactions.find((i) => i.type === type)?.count);

    const nickname = basicInfo?.nickname ?? "未知用户";
    const notesById = new Map<string, SearchResultItem>();
    for (const res of postedWaiter.results) {
      for (const raw of res.data?.notes ?? []) {
        const item = toResultItem(userId, nickname, raw);
        if (item) notesById.set(item.noteId, item);
      }
    }

    if (!basicInfo && notesById.size === 0) {
      log(`用户主页接口未返回可解析数据（userId=${userId}）`);
      const loggedOut = await looksLoggedOut(page);
      throw new Error(
        loggedOut
          ? "未获取到用户主页数据，且页面上检测到'登录'按钮，请先在被连接的浏览器里登录小红书账号。"
          : "未获取到用户主页数据。可能是该用户主页设置了访问限制，也可能是页面结构发生了变化。",
      );
    }

    return {
      userId,
      nickname,
      avatar: basicInfo?.images,
      description: basicInfo?.desc,
      followers: findInteraction("fans"),
      following: findInteraction("follows"),
      noteCount: findInteraction("notes") ?? notesById.size,
      notes: Array.from(notesById.values()).slice(0, cappedLimit),
    };
  });
}
