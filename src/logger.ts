// MCP 使用 stdout 传输 JSON-RPC 消息，任何日志必须写到 stderr，否则会破坏协议帧。
export function log(...args: unknown[]): void {
  console.error("[xhs-mcp]", ...args);
}
