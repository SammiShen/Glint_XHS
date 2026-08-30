import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCdpUrl, parseNonNegativeInt, parsePositiveInt } from "./config.js";

test("parseNonNegativeInt: 未设置/空字符串时使用默认值", () => {
  assert.equal(parseNonNegativeInt(undefined, 5, "X"), 5);
  assert.equal(parseNonNegativeInt("", 5, "X"), 5);
  assert.equal(parseNonNegativeInt("   ", 5, "X"), 5);
});

test("parseNonNegativeInt: 接受 0 和正整数", () => {
  assert.equal(parseNonNegativeInt("0", 5, "X"), 0);
  assert.equal(parseNonNegativeInt("42", 5, "X"), 42);
});

test("parseNonNegativeInt: 负数/NaN/Infinity/非整数一律抛错，不静默兜底", () => {
  assert.throws(() => parseNonNegativeInt("-1", 5, "X"));
  assert.throws(() => parseNonNegativeInt("abc", 5, "X"));
  assert.throws(() => parseNonNegativeInt("Infinity", 5, "X"));
  assert.throws(() => parseNonNegativeInt("1.5", 5, "X"));
});

test("parsePositiveInt: 拒绝 0，未设置时使用默认值", () => {
  assert.throws(() => parsePositiveInt("0", 5, "X"));
  assert.equal(parsePositiveInt("3", 5, "X"), 3);
  assert.equal(parsePositiveInt(undefined, 5, "X"), 5);
});

test("normalizeCdpUrl: 未设置时使用默认值，合法 http(s) 值原样返回", () => {
  assert.equal(normalizeCdpUrl(undefined, "http://127.0.0.1:9222"), "http://127.0.0.1:9222");
  assert.equal(normalizeCdpUrl("http://localhost:9333", "http://127.0.0.1:9222"), "http://localhost:9333");
});

test("normalizeCdpUrl: 拒绝非法 URL 或非 http(s) 协议", () => {
  assert.throws(() => normalizeCdpUrl("not a url", "http://127.0.0.1:9222"));
  assert.throws(() => normalizeCdpUrl("ftp://127.0.0.1:9222", "http://127.0.0.1:9222"));
});
