import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExploreUrl, parseCount, parseNoteRef, parseUserRef } from "./extract.js";

test("parseCount: 解析纯数字字符串/number/空值", () => {
  assert.equal(parseCount("123"), 123);
  assert.equal(parseCount(456), 456);
  assert.equal(parseCount(undefined), undefined);
  assert.equal(parseCount(null), undefined);
  assert.equal(parseCount(""), undefined);
});

test("parseCount: 解析带 万/亿 单位的字符串", () => {
  assert.equal(parseCount("1.2万"), 12000);
  assert.equal(parseCount("3万"), 30000);
  assert.equal(parseCount("1.5亿"), 150000000);
});

test("parseCount: 无法识别的内容返回 undefined 而不是抛错", () => {
  assert.equal(parseCount("abc"), undefined);
});

test("parseNoteRef: 接受格式合法的裸 ID", () => {
  const result = parseNoteRef("64f1a2b3c4d5e6f7a8b9c0d1");
  assert.equal(result.noteId, "64f1a2b3c4d5e6f7a8b9c0d1");
  assert.equal(result.xsecToken, undefined);
});

test("parseNoteRef: 拒绝明显不是 ID 的裸输入", () => {
  assert.throws(() => parseNoteRef("hi"));
  assert.throws(() => parseNoteRef(""));
  assert.throws(() => parseNoteRef("some random sentence with spaces"));
});

test("parseNoteRef: 解析真实小红书链接并保留 xsec_token", () => {
  const result = parseNoteRef(
    "https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f7a8b9c0d1?xsec_token=ABtoken123&xsec_source=pc_search",
  );
  assert.equal(result.noteId, "64f1a2b3c4d5e6f7a8b9c0d1");
  assert.equal(result.xsecToken, "ABtoken123");
});

test("parseNoteRef: 拒绝非小红书域名的链接", () => {
  assert.throws(
    () => parseNoteRef("https://www.evil.com/explore/64f1a2b3c4d5e6f7a8b9c0d1"),
    /域名不属于小红书/,
  );
});

test("parseNoteRef: 拒绝没有路径片段的链接", () => {
  assert.throws(() => parseNoteRef("https://www.xiaohongshu.com/"), /没有可用的路径片段/);
});

test("parseUserRef: 接受裸 ID 和真实主页链接，拒绝其它域名", () => {
  assert.equal(parseUserRef("5f1a2b3c4d5e6f7a8b9c0d1e"), "5f1a2b3c4d5e6f7a8b9c0d1e");
  assert.equal(
    parseUserRef("https://www.xiaohongshu.com/user/profile/5f1a2b3c4d5e6f7a8b9c0d1e"),
    "5f1a2b3c4d5e6f7a8b9c0d1e",
  );
  assert.throws(() => parseUserRef("https://www.evil.com/user/profile/5f1a2b3c4d5e6f7a8b9c0d1e"));
});

test("buildExploreUrl: 附带 xsec_token 时正确拼接查询参数", () => {
  const url = buildExploreUrl("abc123def456", "tok");
  assert.match(url, /xsec_token=tok/);
  assert.match(url, /xsec_source=pc_search/);
});
