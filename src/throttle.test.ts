import { test } from "node:test";
import assert from "node:assert/strict";
import { createThrottler } from "./throttle.js";

test("createThrottler: 并发调用被串行化，两两放行间隔不小于设定延迟", async () => {
  const delay = 60;
  const throttler = createThrottler(() => delay);
  const releaseTimes: number[] = [];

  await Promise.all(
    [0, 1, 2, 3].map(async () => {
      await throttler.wait();
      releaseTimes.push(Date.now());
    }),
  );

  releaseTimes.sort((a, b) => a - b);
  for (let i = 1; i < releaseTimes.length; i++) {
    const gap = releaseTimes[i] - releaseTimes[i - 1];
    assert.ok(gap >= delay - 15, `第 ${i} 次放行与上一次间隔太短：${gap}ms（应接近 ${delay}ms）`);
  }
});

test("createThrottler: 一次调用异常不会卡住后续调用", async () => {
  let calls = 0;
  const throttler = createThrottler(() => {
    calls += 1;
    if (calls === 1) {
      throw new Error("boom");
    }
    return 10;
  });

  await assert.rejects(() => throttler.wait());
  await throttler.wait();
  assert.equal(calls, 2);
});
