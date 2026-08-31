import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExploreUrl,
  isXhsHost,
  parseCount,
  parseNoteRef,
  parseUserRef,
  pickContentCandidate,
  pickTitleCandidate,
  type DomTextCandidate,
} from "./extract.js";

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

test("isXhsHost: 只认 xiaohongshu.com 及其子域名", () => {
  assert.equal(isXhsHost("https://www.xiaohongshu.com/explore/abc"), true);
  assert.equal(isXhsHost("https://edith.xiaohongshu.com/api/sns/web/v1/feed"), true);
  assert.equal(isXhsHost("https://evil.com/xiaohongshu.com"), false);
  assert.equal(isXhsHost("not a url"), false);
});

test("pickContentCandidate: 回归用例——不再把导航栏文案误当正文", () => {
  // 复现真实 bug 报告：不管传入哪条笔记，抓到的 content 都固定是这段导航栏拼接文案。
  const navBarBug: DomTextCandidate = { text: "首页点点aiRED直播发布通知消息我我", isChrome: true, anchorCount: 8 };
  const realContent: DomTextCandidate = {
    text: "今天分享一个超好用的旅行小技巧，出门前一定要检查这三样东西……（后面还有很长的正文内容）",
    isChrome: false,
    anchorCount: 0,
  };
  assert.equal(pickContentCandidate([navBarBug, realContent]), realContent.text);
  assert.equal(pickContentCandidate([navBarBug]), undefined);
});

test("pickContentCandidate: 高链接密度（导航菜单特征）即使不在 chrome 容器里也被排除", () => {
  const menuLike: DomTextCandidate = { text: "首页发现购物直播消息我的关注收藏历史记录设置帮助", isChrome: false, anchorCount: 10 };
  const real: DomTextCandidate = { text: "这是一段正常的、足够长的笔记正文内容示例文本", isChrome: false, anchorCount: 1 };
  assert.equal(pickContentCandidate([menuLike, real]), real.text);
});

test("pickContentCandidate: 太短的候选（低于最小长度阈值）不会被选中", () => {
  const tooShort: DomTextCandidate = { text: "还行吧", isChrome: false, anchorCount: 0 };
  assert.equal(pickContentCandidate([tooShort]), undefined);
});

test("pickContentCandidate: 多个合法候选时取文本最长的一条", () => {
  const shortReal: DomTextCandidate = { text: "这是比较短的一段候选正文内容示例", isChrome: false, anchorCount: 0 };
  const longReal: DomTextCandidate = {
    text: "这是比较长的一段候选正文内容示例，包含更多细节和描述，理应被优先选中作为最终正文",
    isChrome: false,
    anchorCount: 0,
  };
  assert.equal(pickContentCandidate([shortReal, longReal]), longReal.text);
});

test("pickTitleCandidate: 排除 chrome 容器候选，取第一个非空的正常候选", () => {
  const chromeTitle: DomTextCandidate = { text: "小红书", isChrome: true, anchorCount: 0 };
  const realTitle: DomTextCandidate = { text: "早安，今天也要元气满满", isChrome: false, anchorCount: 0 };
  assert.equal(pickTitleCandidate([chromeTitle, realTitle]), realTitle.text);
});

test("pickTitleCandidate: 没有可用候选时返回 undefined", () => {
  assert.equal(pickTitleCandidate([{ text: "", isChrome: false, anchorCount: 0 }]), undefined);
});
