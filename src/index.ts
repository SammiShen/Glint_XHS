#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchNotes } from "./xhs/searchNotes.js";
import { getNoteDetail } from "./xhs/noteDetail.js";
import { getNoteComments } from "./xhs/noteComments.js";
import { getUserProfile } from "./xhs/userProfile.js";
import { log } from "./logger.js";

// 这是一个纯只读工具：只提供搜索/查看能力，不注册任何发布、评论、点赞、关注等写入类工具。
const server = new McpServer({
  name: "xhs-readonly-mcp",
  version: "0.1.0",
});

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  log("工具执行出错：", message);
  return { content: [{ type: "text" as const, text: `出错了：${message}` }], isError: true };
}

server.registerTool(
  "search_notes",
  {
    title: "搜索小红书笔记",
    description:
      "按关键词搜索小红书公开笔记，返回标题、作者、封面、点赞/收藏/评论数等基础信息。只读，不做任何互动操作。",
    inputSchema: {
      keyword: z.string().min(1).describe("搜索关键词"),
      limit: z.number().int().min(1).max(60).optional().describe("最多返回多少条结果，默认 20，最多 60"),
    },
  },
  async ({ keyword, limit }) => {
    try {
      const items = await searchNotes(keyword, limit ?? 20);
      return jsonResult(items);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_note_detail",
  {
    title: "获取笔记详情",
    description:
      "输入笔记链接（或笔记 ID）获取完整内容：标题、正文、作者信息、发布时间、图片/视频链接、标签。只读。",
    inputSchema: {
      note: z.string().min(1).describe("笔记的完整 URL，或者笔记 ID"),
    },
  },
  async ({ note }) => {
    try {
      const detail = await getNoteDetail(note);
      return jsonResult(detail);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_note_comments",
  {
    title: "获取笔记评论",
    description:
      "输入笔记链接（或笔记 ID）获取该笔记下的评论列表，包含评论者、内容、点赞数，以及二级评论的回复关系。只读，不做发表评论操作。",
    inputSchema: {
      note: z.string().min(1).describe("笔记的完整 URL，或者笔记 ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("最多返回多少条顶层评论，默认 30，最多 200"),
    },
  },
  async ({ note, limit }) => {
    try {
      const comments = await getNoteComments(note, limit ?? 30);
      return jsonResult(comments);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_user_profile",
  {
    title: "获取用户主页信息",
    description: "输入用户主页链接（或用户 ID）获取该用户的公开笔记列表和基础信息。只读，不做关注操作。",
    inputSchema: {
      user: z.string().min(1).describe("用户主页的完整 URL，或者用户 ID"),
      notesLimit: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe("最多返回多少条笔记，默认 20，最多 60"),
    },
  },
  async ({ user, notesLimit }) => {
    try {
      const profile = await getUserProfile(user, notesLimit ?? 20);
      return jsonResult(profile);
    } catch (err) {
      return errorResult(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("xhs-readonly-mcp 已启动（只读：search_notes / get_note_detail / get_note_comments / get_user_profile）");
}

main().catch((err) => {
  log("启动失败：", err);
  process.exit(1);
});
