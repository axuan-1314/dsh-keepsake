// dsh-keepsake 提取触发门槛（打分门）：纯函数，零 IO
import { countProseWords, isMachineOrigin } from "./transcript.js";

/** 打分门默认阈值（用户词数 + 2*工具种类 + 2*轮次 ≥ 6 通过）。 */
export const GATE_DEFAULT_MIN_SCORE = 6;

/**
 * 从会话事件数组计算提取证据分数。
 * @param {Array} events - 会话事件数组
 * @returns {{ userWords: number, toolKinds: number, turns: number, score: number }}
 */
export function scoreExtractionEvidence(events) {
  let userWords = 0;
  const toolKindsSet = new Set();
  let turns = 0;

  if (!Array.isArray(events)) {
    return { userWords: 0, toolKinds: 0, turns: 0, score: 0 };
  }

  for (const event of events) {
    if (event === null || typeof event !== "object") continue;

    // 统计工具种类（tool/call 事件的 data.name 去重）
    if (event.type === "tool/call") {
      const name = event.data?.name;
      if (typeof name === "string" && name.length > 0) {
        toolKindsSet.add(name);
      }
    }

    // 统计用户词数和轮次（仅 append 面的真人 user/message）
    if (event.type === "user/message") {
      const surfaceOp = event.surfaceOp;
      if (surfaceOp !== void 0 && surfaceOp !== "append") continue;

      const data = event.data;
      if (data === void 0 || data === null || typeof data !== "object") continue;

      const message = data.message ?? data;
      if (typeof message !== "object" || message === void 0) continue;
      if (!Array.isArray(message.content)) continue;

      // 机器来源不计入（判据复用 transcript.js 的 isMachineOrigin）
      if (isMachineOrigin(message)) continue;

      // 提取文本并统计词数
      const text = (message.content ?? [])
        .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join(" ")
        .trim();
      userWords += countProseWords(text);
      turns += 1;
    }
  }

  const toolKinds = toolKindsSet.size;
  const score = userWords + 2 * toolKinds + 2 * turns;
  return { userWords, toolKinds, turns, score };
}

/**
 * 打分门决策：根据分数决定是否通过提取门槛。
 * @param {Array} events - 会话事件数组
 * @param {{ enabled?: boolean, minScore?: number }} options - 配置项
 * @returns {{ pass: boolean, reason?: string, score: number, parts: { userWords: number, toolKinds: number, turns: number } }}
 */
export function gateDecision(events, { enabled = true, minScore = GATE_DEFAULT_MIN_SCORE } = {}) {
  const parts = scoreExtractionEvidence(events);
  if (!enabled) {
    return { pass: true, score: parts.score, parts };
  }
  if (parts.score < minScore) {
    return { pass: false, reason: "thin-evidence", score: parts.score, parts };
  }
  return { pass: true, score: parts.score, parts };
}
