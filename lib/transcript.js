// dsh-memory 增量扫描（规格边界⑤：触发门槛）。
//   skip 双条件：①增量内无 ≥3 词合格用户散文（no-user-prose）
//              ②增量内主 agent 直写记忆区间（write/edit 落 memoryRoot）
//   同时产出提取提示词用的增量 transcript 摘录。
import { isInsideRoot } from "./filename.js";
import { resolve } from "node:path";

/** 会写文件的 DSH 内建工具名（dsh-tool-fs 实测注册名）。 */
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

/** 判定一个会话事件是否为“追加进表面”的消息事件（替换/压缩影子不算新增内容）。 */
export function isAppendSurfaceEvent(event) {
  return event?.surfaceOp === void 0 || event.surfaceOp === "append";
}

/** 提取消息事件里的消息体（user/message 的 data 即消息，其余在 data.message）。 */
export function messageOf(event) {
  const data = event?.data;
  if (data === void 0 || data === null || typeof data !== "object") return void 0;
  const message = data.message ?? data;
  if (typeof message !== "object" || message === void 0) return void 0;
  if (!Array.isArray(message.content)) return void 0;
  return message;
}

/** 拼接消息中全部 text 块。 */
export function textBlocksOf(message) {
  return (message?.content ?? [])
    .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ")
    .trim();
}

/**
 * 合格用户散文判定。规格为 ≥minWords 个空白分隔词（英文口径）；
 * CJK 无空格分词，按 2 字≈1 词折算后并入词数（有效词数 = 空格词数 + ⌊CJK 字数/2⌋）。
 */
export function hasEnoughUserProse(events, minWords = 3) {
  for (const event of events) {
    if (event?.type !== "user/message" || !isAppendSurfaceEvent(event)) continue;
    const text = textBlocksOf(messageOf(event));
    const tokens = text.split(/\s+/).filter((word) => word.length > 0);
    const cjkChars = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
    if (tokens.length + Math.floor(cjkChars / 2) >= minWords) return true;
  }
  return false;
}

/**
 * 直写记忆判定（skip 条件②）：增量内 write/edit 的 file_path 落在 memoryRoot 内，
 * 且结果非错误（沙箱/权限拒绝的直写尝试不算直写，否则被拒的写入会吞掉整轮提取）。
 * 结果缺失（未见 result 事件）按成功计——贴近 ZCode 的调用侧判定口径。
 */
export function hasDirectMemoryWrite(events, memoryRoot) {
  const rootWrites = new Set(); // callId
  for (const event of events) {
    if (event?.type !== "tool/call") continue;
    const data = event.data;
    if (data === void 0 || typeof data !== "object") continue;
    const name = typeof data.name === "string" ? data.name.toLowerCase() : "";
    if (!FILE_WRITE_TOOLS.has(name)) continue;
    let args;
    try {
      args = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments;
    } catch {
      continue; // 参数非 JSON：不判直写
    }
    const rawPath = args !== void 0 && args !== null && typeof args === "object"
      ? (args.file_path ?? args.path)
      : void 0;
    if (typeof rawPath !== "string" || rawPath.length === 0) continue;
    // 直写判定走纯包含性（absolute 直写路径不经过模型相对名消毒器）
    if (isInsideRoot(memoryRoot, resolve(memoryRoot, rawPath))) rootWrites.add(data.callId);
  }
  if (rootWrites.size === 0) return false;
  for (const event of events) {
    if (event?.type !== "tool/result") continue;
    const message = messageOf(event);
    const callId = message?.source?.callId ?? message?.toolCallId;
    if (callId !== void 0 && rootWrites.has(callId) && message?.isError === true) {
      rootWrites.delete(callId); // 该直写失败：不算
    }
  }
  return rootWrites.size > 0;
}

/**
 * 规格双 skip 条件（顺序照 ZCode：direct-memory-write 优先于 no-user-prose）。
 * @returns 'direct-memory-write' | 'no-user-prose' | null（null = 不跳过）
 */
export function skipReason(events, memoryRoot, minWords = 3) {
  if (hasDirectMemoryWrite(events, memoryRoot)) return "direct-memory-write";
  if (!hasEnoughUserProse(events, minWords)) return "no-user-prose";
  return null;
}

/** 增量 transcript 摘录（提取提示词输入）。 */
export function renderTranscript(events, { maxMessageChars = 800 } = {}) {
  const lines = [];
  for (const event of events) {
    const seq = typeof event?.seq === "number" ? event.seq : "?";
    if (event?.type === "user/message") {
      if (!isAppendSurfaceEvent(event)) continue;
      const text = clip(textBlocksOf(messageOf(event)), maxMessageChars);
      if (text.length > 0) lines.push(`[seq ${seq}] User: ${text}`);
      continue;
    }
    if (event?.type === "assistant/message") {
      if (!isAppendSurfaceEvent(event)) continue;
      const text = clip(textBlocksOf(messageOf(event)), maxMessageChars);
      if (text.length > 0) lines.push(`[seq ${seq}] Assistant: ${text}`);
      continue;
    }
    if (event?.type === "tool/call") {
      const data = event.data ?? {};
      lines.push(`[seq ${seq}] ToolCall ${data.name}: ${clip(String(data.arguments ?? ""), 200)}`);
      continue;
    }
    if (event?.type === "tool/result") {
      const message = messageOf(event);
      const text = clip(textBlocksOf(message), 200);
      if (text.length > 0) lines.push(`[seq ${seq}] ToolResult: ${text}`);
    }
  }
  return lines.join("\n");
}

function clip(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
