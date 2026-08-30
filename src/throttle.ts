/**
 * 真正串行的节流器：并发调用会排队，一个接一个地"轮到自己"再计算/等待间隔，
 * 而不是像"共享一个 lastActionAt 时间戳、各自独立 sleep"那样，容易出现
 * 两个并发调用读到同一个旧时间戳、算出同样的等待时长、几乎同时被放行的竞态。
 *
 * 排队链上任意一环出错都不会卡住后面的调用（见 queue = turn.catch(() => {})）。
 */
export interface Throttler {
  wait(): Promise<void>;
}

export function createThrottler(getDelayMs: () => number): Throttler {
  let queue: Promise<void> = Promise.resolve();
  let lastReleaseAt = 0;

  function wait(): Promise<void> {
    const turn = queue.then(async () => {
      const delay = Math.max(0, getDelayMs());
      const elapsed = Date.now() - lastReleaseAt;
      const remaining = delay - elapsed;
      if (remaining > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      }
      lastReleaseAt = Date.now();
    });
    // 无论这一轮成功还是失败，队列都要继续往前走，否则一次异常会永久卡住后续调用。
    queue = turn.catch(() => {});
    return turn;
  }

  return { wait };
}
