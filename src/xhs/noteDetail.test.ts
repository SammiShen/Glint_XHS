import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables } from "./noteDetail.js";

const { extractNoteCardFromResponse, normalizeNoteCard } = __testables;

test("extractNoteCardFromResponse: 经典结构 data.items[].note_card，匹配对应 noteId", () => {
  const json = {
    data: {
      items: [
        { id: "other-note-id", note_card: { title: "别的笔记" } },
        { id: "target-note-id", note_card: { title: "目标笔记", desc: "正文内容" } },
      ],
    },
  };
  const card = extractNoteCardFromResponse(json, "target-note-id");
  assert.ok(card);
  assert.equal(card?.title, "目标笔记");
  assert.equal(card?.desc, "正文内容");
});

test("extractNoteCardFromResponse: camelCase 的 noteCard 包裹", () => {
  const json = { data: { items: [{ id: "n1", noteCard: { title: "标题", desc: "正文" } }] } };
  const card = extractNoteCardFromResponse(json, "n1");
  assert.ok(card);
  assert.equal(card?.title, "标题");
});

test("extractNoteCardFromResponse: 条目本身就是卡片，没有额外包一层", () => {
  const json = { data: { items: [{ id: "n1", title: "标题", desc: "正文", interact_info: {} }] } };
  const card = extractNoteCardFromResponse(json, "n1");
  assert.ok(card);
  assert.equal(card?.title, "标题");
});

test("extractNoteCardFromResponse: data.note 直接就是笔记对象", () => {
  const json = { data: { note: { title: "标题", desc: "正文" } } };
  const card = extractNoteCardFromResponse(json, "any-id");
  assert.ok(card);
  assert.equal(card?.title, "标题");
});

test("extractNoteCardFromResponse: data 本身就带笔记特征字段时直接当卡片用", () => {
  const json = { data: { desc: "正文", title: "标题" } };
  const card = extractNoteCardFromResponse(json, "any-id");
  assert.ok(card);
  assert.equal(card?.desc, "正文");
});

test("extractNoteCardFromResponse: 找不到任何笔记特征时返回 undefined", () => {
  assert.equal(extractNoteCardFromResponse({ data: { unrelated: true } }, "n1"), undefined);
  assert.equal(extractNoteCardFromResponse(null, "n1"), undefined);
  assert.equal(extractNoteCardFromResponse("not json", "n1"), undefined);
});

test("normalizeNoteCard: 缺失字段时使用合理默认值，不抛错", () => {
  const detail = normalizeNoteCard("n1", {});
  assert.equal(detail.noteId, "n1");
  assert.equal(detail.title, "(无标题)");
  assert.equal(detail.content, "");
  assert.equal(detail.author.nickname, "未知用户");
  assert.deepEqual(detail.images, []);
});

test("normalizeNoteCard: 正常字段（snake_case）被正确映射", () => {
  const detail = normalizeNoteCard("n1", {
    title: "标题",
    desc: "正文内容",
    type: "video",
    user: { user_id: "u1", nickname: "小明" },
    interact_info: { liked_count: "100", collected_count: "5万", comment_count: "3" },
  });
  assert.equal(detail.title, "标题");
  assert.equal(detail.content, "正文内容");
  assert.equal(detail.type, "video");
  assert.equal(detail.author.nickname, "小明");
  assert.equal(detail.likes, 100);
  assert.equal(detail.collects, 50000);
  assert.equal(detail.comments, 3);
});
