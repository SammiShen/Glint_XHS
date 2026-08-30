import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkCdpEndpoint, formatCdpError } from "./cdp.js";

function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("failed to get server address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${(address as AddressInfo).port}`,
        close: () =>
          new Promise((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

test("checkCdpEndpoint: 端口没有监听时返回 connection-refused", async () => {
  const result = await checkCdpEndpoint("http://127.0.0.1:39999", 1000);
  assert.equal(result.status, "connection-refused");
});

test("checkCdpEndpoint: 响应包含 webSocketDebuggerUrl 时返回 ok", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Browser: "Chrome/1.0", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/abc" }));
  });
  try {
    const result = await checkCdpEndpoint(server.url, 1000);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.browser, "Chrome/1.0");
    }
  } finally {
    await server.close();
  }
});

test("checkCdpEndpoint: JSON 缺少 devtools 字段时返回 invalid-response", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hello: "world" }));
  });
  try {
    const result = await checkCdpEndpoint(server.url, 1000);
    assert.equal(result.status, "invalid-response");
  } finally {
    await server.close();
  }
});

test("checkCdpEndpoint: 非 2xx 状态码时返回 invalid-response", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  try {
    const result = await checkCdpEndpoint(server.url, 1000);
    assert.equal(result.status, "invalid-response");
  } finally {
    await server.close();
  }
});

test("checkCdpEndpoint: 请求超时时返回 unreachable", async () => {
  const server = await listen(() => {
    // 故意不响应，触发调用方超时中止。
  });
  try {
    const result = await checkCdpEndpoint(server.url, 200);
    assert.equal(result.status, "unreachable");
  } finally {
    await server.close();
  }
});

test("formatCdpError: 三种失败原因给出不同的排查建议", () => {
  const refused = formatCdpError("http://127.0.0.1:9222", { status: "connection-refused" });
  const invalid = formatCdpError("http://127.0.0.1:9222", { status: "invalid-response", detail: "x" });
  const unreachable = formatCdpError("http://127.0.0.1:9222", { status: "unreachable", detail: "y" });

  assert.match(refused, /npm run browser:mac/);
  assert.match(refused, /--user-data-dir/);
  // "登录" 可以作为后续操作提示出现（启动浏览器后去登录），但根因诊断不能写成"可能未登录"。
  assert.doesNotMatch(refused, /可能未?登录|疑似未登录/);
  assert.match(invalid, /被其他程序占用/);
  assert.match(unreachable, /y/);
});
