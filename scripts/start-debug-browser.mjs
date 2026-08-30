#!/usr/bin/env node
// 一键启动一个带远程调试端口的 Chrome，使用独立 profile（不碰用户日常使用的 Chrome profile）。
// 独立成一个不依赖 TS 构建产物的脚本，这样在还没跑 npm run build 之前也能先用它把浏览器备好。
//
// 环境变量（都可选）：
//   XHS_CDP_PORT          调试端口，默认 9222
//   XHS_CHROME_PROFILE_DIR 独立 profile 目录，默认 ~/.xhs-mcp-chrome-profile
//   XHS_CHROME_PATH       Chrome 可执行文件路径，不设置则按平台使用默认位置

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.XHS_CDP_PORT ?? 9222);
if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error(`[browser] XHS_CDP_PORT 不是合法端口号："${process.env.XHS_CDP_PORT}"`);
  process.exit(1);
}
const PROFILE_DIR = process.env.XHS_CHROME_PROFILE_DIR ?? path.join(os.homedir(), ".xhs-mcp-chrome-profile");
const CDP_URL = `http://127.0.0.1:${PORT}`;

const DEFAULT_CHROME_PATHS = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  linux: "google-chrome",
};

function resolveChromePath() {
  if (process.env.XHS_CHROME_PATH) return process.env.XHS_CHROME_PATH;
  const platformDefault = DEFAULT_CHROME_PATHS[process.platform];
  if (!platformDefault) {
    throw new Error(
      `不认识当前平台 "${process.platform}" 的默认 Chrome 路径。请设置 XHS_CHROME_PATH 指向 Chrome 可执行文件。`,
    );
  }
  // linux 下默认值是一个命令名（走 PATH 查找），不是绝对路径，不用 existsSync 检查。
  if (process.platform !== "linux" && !existsSync(platformDefault)) {
    throw new Error(
      `没有在默认位置找到 Chrome：${platformDefault}\n` +
        "请设置 XHS_CHROME_PATH 环境变量指向你的 Chrome 可执行文件。",
    );
  }
  return platformDefault;
}

/** @returns {Promise<{status: "ok"|"free"|"invalid", browser?: string}>} */
async function checkCdp(timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: controller.signal });
    if (!res.ok) return { status: "invalid" };
    const json = await res.json().catch(() => null);
    if (json && typeof json === "object" && (json.webSocketDebuggerUrl || json.Browser)) {
      return { status: "ok", browser: json.Browser };
    }
    return { status: "invalid" };
  } catch (err) {
    const code = err && err.cause && err.cause.code;
    if (code === "ECONNREFUSED") return { status: "free" };
    // 超时、DNS 失败等其它情况，保守起见当作"端口上有什么东西但不正常"处理，不去抢着启动浏览器。
    return { status: "invalid" };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdp(timeoutMs = 15000, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await checkCdp(1000);
    if (result.status === "ok") return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function printInfo() {
  console.log("");
  console.log(`CDP URL:      ${CDP_URL}`);
  console.log(`Profile 路径: ${PROFILE_DIR}`);
  console.log("");
  console.log("如果是第一次使用这个 profile，请在这个浏览器窗口里手动登录一次小红书账号。");
  console.log("使用 MCP 工具期间请保持这个浏览器窗口持续运行。");
  console.log("");
  console.log(`可以用下面这条命令验证 CDP 是否正常：`);
  console.log(`  curl ${CDP_URL}/json/version`);
}

async function main() {
  console.log(`[browser] 检查端口 ${PORT} 上是否已有可用的 CDP 端点…`);
  const existing = await checkCdp();

  if (existing.status === "ok") {
    console.log(`[browser] 端口 ${PORT} 已经有可用的 Chrome DevTools 端点（${existing.browser ?? "未知浏览器"}），直接复用，不重复启动。`);
    printInfo();
    return;
  }

  if (existing.status === "invalid") {
    console.error(
      `[browser] 端口 ${PORT} 已经被占用，但返回内容不像 Chrome 的调试端口。\n` +
        "这个端口可能被别的程序占用了。请设置 XHS_CDP_PORT 换一个端口，或者先关闭占用该端口的程序。",
    );
    process.exitCode = 1;
    return;
  }

  const chromePath = resolveChromePath();
  console.log("[browser] 端口空闲，使用独立 profile 启动 Chrome：");
  console.log(`  可执行文件：${chromePath}`);
  console.log(`  profile 目录：${PROFILE_DIR}`);
  console.log(`  调试端口：${PORT}`);

  const child = spawn(chromePath, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const spawnError = await new Promise((resolve) => {
    child.once("error", resolve);
    // 给 spawn 一个 tick 判断是否立刻失败（比如可执行文件不存在），没失败就继续走轮询逻辑。
    setTimeout(() => resolve(null), 500);
  });
  if (spawnError) {
    console.error(`[browser] 启动 Chrome 失败：${spawnError.message}`);
    process.exitCode = 1;
    return;
  }

  const started = await waitForCdp();
  if (!started) {
    console.error("[browser] Chrome 已尝试启动，但等待 15 秒后仍未探测到可用的 CDP 端点，请手动检查浏览器是否正常打开。");
    process.exitCode = 1;
    return;
  }

  console.log("[browser] Chrome 已启动，CDP 连接正常。");
  printInfo();
}

main().catch((err) => {
  console.error(`[browser] 出错：${err.message}`);
  process.exitCode = 1;
});
