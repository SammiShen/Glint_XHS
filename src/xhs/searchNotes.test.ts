import { test } from "node:test";
import assert from "node:assert/strict";
import { __testables } from "./searchNotes.js";

const { extractItemsArray, toResultItem } = __testables;

test("extractItemsArray: 支持 data.items / data.notes / 顶层 items 几种形状", () => {
  assert.equal(extractItemsArray({ data: { items: [1, 2] } }).length, 2);
  assert.equal(extractItemsArray({ data: { notes: [1, 2, 3] } }).length, 3);
  assert.equal(extractItemsArray({ items: [1] }).length, 1);
  assert.deepEqual(extractItemsArray({ data: {} }), []);
  assert.deepEqual(extractItemsArray(null), []);
  assert.deepEqual(extractItemsArray("not an object"), []);
});

test("toResultItem: 兼容 snake_case + note_card 包裹的经典结构", () => {
  const item = toResultItem({
    id: "64f1a2b3c4d5e6f7a8b9c0d1",
    xsec_token: "tok123",
    note_card: {
      type: "normal",
      display_title: "标题A",
      user: { user_id: "u1", nickname: "小明" },
      interact_info: { liked_count: "1.2万", collected_count: "12", comment_count: "3" },
      cover: { url_default: "https://img.example/a.jpg" },
    },
  });
  assert.ok(item);
  assert.equal(item?.noteId, "64f1a2b3c4d5e6f7a8b9c0d1");
  assert.equal(item?.title, "标题A");
  assert.equal(item?.author.nickname, "小明");
  assert.equal(item?.likes, 12000);
  assert.equal(item?.collects, 12);
  assert.equal(item?.comments, 3);
  assert.match(item?.url ?? "", /xsec_token=tok123/);
  assert.equal(item?.cover, "https://img.example/a.jpg");
});

test("toResultItem: 兼容 camelCase + noteCard 命名变体", () => {
  const item = toResultItem({
    noteId: "abc123def456",
    xsecToken: "tokXYZ",
    noteCard: {
      type: "video",
      displayTitle: "标题B",
      user: { userId: "u2", nickname: "小红" },
      interactInfo: { likedCount: "500", collectedCount: "10", commentCount: "1" },
    },
  });
  assert.ok(item);
  assert.equal(item?.noteId, "abc123def456");
  assert.equal(item?.title, "标题B");
  assert.equal(item?.type, "video");
  assert.equal(item?.likes, 500);
  assert.match(item?.url ?? "", /xsec_token=tokXYZ/);
});

test("toResultItem: 字段被拍平在条目本身、没有 note_card 包裹也能解析", () => {
  const item = toResultItem({
    note_id: "flat123456",
    title: "拍平结构标题",
  });
  assert.ok(item);
  assert.equal(item?.noteId, "flat123456");
  assert.equal(item?.title, "拍平结构标题");
});

test("toResultItem: 只要有 noteId，其它字段全部缺失也不丢弃整条", () => {
  const item = toResultItem({ id: "onlyid123456" });
  assert.ok(item);
  assert.equal(item?.noteId, "onlyid123456");
  assert.equal(item?.title, "(无标题)");
  assert.equal(item?.author.nickname, "未知用户");
  assert.equal(item?.likes, undefined);
});

test("toResultItem: 完全解析不出 noteId 时返回 undefined", () => {
  assert.equal(toResultItem({ note_card: { display_title: "没有 id" } }), undefined);
  assert.equal(toResultItem("not an object"), undefined);
  assert.equal(toResultItem(null), undefined);
});
