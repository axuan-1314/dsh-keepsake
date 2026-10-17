// dsh-keepsake 增量扫描（规格边界⑤：触发门槛）。
//   skip 双条件：①增量内无 ≥3 词合格用户散文（no-user-prose）
//              ②增量内主 agent 直写记忆区间（write/edit 落 memoryRoot，含 run_code 里的 tools.write/edit）
//   同时产出提取提示词用的增量 transcript 摘录。
import { isInsideRoot } from "./filename.js";
import { stripMemoryMarkup } from "./inject-channel.js";
import { resolve } from "node:path";

/** 会写文件的 DSH 内建工具名（dsh-tool-fs 实测注册名）。 */
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

/** run_code 工具名：主 agent 的常见直写路径（在代码里调 tools.write/tools.edit）。 */
const RUN_CODE_TOOL = "run_code";

/** 代码文本里的 tools.write( / tools.edit( 调用点（文本级 best-effort，不做 JS 语法解析）。 */
const RUN_CODE_WRITE_CALL = /\btools\s*\.\s*(write|edit)\s*\(/g;

/** 调用点之后的 file_path 字符串值（双/单/反引号三种引号；分组 1/2/3 分别对应）。 */
const FILE_PATH_ARG = /\bfile_path\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/;

/** file_path 的查找窗口（调用点之后的字符数）：够覆盖多行对象实参，又不至串到后续调用头上。 */
const RUN_CODE_ARG_WINDOW = 400;

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

/** 已知会把非真人内容放进用户角色消息的来源类型。 */
const MACHINE_SOURCE_KINDS = new Set([
  "inject",
  "instruction",
  "system",
  "tool",
  "summary",
  "compaction",
  "memory",
  "note",
  "synthetic",
]);

/**
 * 判定消息是否明确来自机器注入。
 * 判据故意从窄：假阴性会把机器话当真人，最多多跑一轮提取，不会丢数据；
 * 假阳性会把真人话当机器并丢掉记忆，所以只认 `plugin:` 前缀和已知机器类型，未知类型一律按真人处理。
 */
export function isMachineOrigin(message) {
  const kind = message?.source?.kind;
  return typeof kind === "string" && (kind.startsWith("plugin:") || MACHINE_SOURCE_KINDS.has(kind));
}

/**
 * 合格用户散文判定。规格为 ≥minWords 个空白分隔词（英文口径）；
 * CJK 无空格分词，按 2 字≈1 词折算后并入词数（有效词数 = 空格词数 + ⌊CJK 字数/2⌋）。
 * 防自食：跳过来源明确为机器的 user/message，否则注入长文会架空 ≥3 词门槛。
 */
export function hasEnoughUserProse(events, minWords = 3) {
  for (const event of events) {
    if (event?.type !== "user/message" || !isAppendSurfaceEvent(event)) continue;
    const msg = messageOf(event);
    if (isMachineOrigin(msg)) continue; // 明确的机器注入不算用户散文
    const text = textBlocksOf(msg);
    const tokens = text.split(/\s+/).filter((word) => word.length > 0);
    const cjkChars = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
    if (tokens.length + Math.floor(cjkChars / 2) >= minWords) return true;
  }
  return false;
}

/**
 * 直写记忆判定（skip 条件②）：增量内 write/edit 的 file_path 落在 memoryRoot 内，
 * 且结果非错误（沙箱/权限拒绝的直写尝试不算直写，否则被拒的写入会吞掉整轮提取）。
 * 结果缺失（未见 result 事件）按成功计——贴近调用侧的判定口径。
 *
 * 两条识别路径，命中其一即计入该 callId（后续统一走失败豁免）：
 *   ① 原生工具调用：tool/call 的 name 为 write/edit，取 arguments.file_path / .path；
 *   ② run_code：主 agent 在代码里调 tools.write/tools.edit 直写记忆目录（实测高频写法），
 *      取 arguments.code 在文本里找 tools.write(/tools.edit(，再从调用点往后的窗口内取 file_path 值。
 * 判定局限（best-effort，与"贴近调用侧"口径一致）：不做 JS 语法解析，两个方向都可能出错——
 *   假阴性（漏识别）：pwsh/ops_bash 里的写入、解构别名（const { write } = tools 后裸调 write(）
 *     等形态识别不了 → 该轮提取照跑，多花一次 LLM 调用，无数据损失（保守方向）；
 *   假阳性（误识别）：代码文本里出现 tools.write({file_path: "<记忆目录内路径>"} 字面量但并未执行
 *     （如字符串里的示例代码）→ 该轮提取被跳过，对话内容无痕丢失。为把误识别面收窄，
 *     扫描前先剥掉块注释与整行行注释（注释里的示例代码不该被当真）；字符串字面量内的
 *     误识别无法廉价排除，属已知取舍——所以 journal 里 `skipped/direct-memory-write`
 *     也是一条可见记录，"这轮没提"至少可查。
 */
export function hasDirectMemoryWrite(events, memoryRoot) {
  const rootWrites = new Set(); // callId
  for (const event of events) {
    if (event?.type !== "tool/call") continue;
    const data = event.data;
    if (data === void 0 || typeof data !== "object") continue;
    const name = typeof data.name === "string" ? data.name.toLowerCase() : "";
    if (name === RUN_CODE_TOOL) {
      const code = codeArgumentOf(data);
      for (const rawPath of filePathsInRunCode(code)) {
        if (isInsideRoot(memoryRoot, safeResolve(memoryRoot, rawPath))) rootWrites.add(data.callId);
      }
      continue;
    }
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

/** 取 run_code 调用的 code 实参（arguments 可能是 JSON 字符串，也可能已是对象）。 */
function codeArgumentOf(data) {
  let args;
  try {
    args = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments;
  } catch {
    return void 0; // 参数非 JSON：无从读 code
  }
  if (args === void 0 || args === null || typeof args !== "object") return void 0;
  const code = args.code;
  return typeof code === "string" ? code : void 0;
}

/**
 * 从 run_code 代码文本里提取 tools.write/tools.edit 的目标路径（可能多个）。
 * 文本级：先剥注释，再定位调用点，在该点往后的窗口内找 file_path 的字符串值（三种引号）。
 */
function filePathsInRunCode(code) {
  if (typeof code !== "string" || code.length === 0) return [];
  const source = stripCodeComments(code);
  const found = [];
  RUN_CODE_WRITE_CALL.lastIndex = 0; // 复用全局正则：每次从头扫，避免 lastIndex 残留跨调用串味
  let call = RUN_CODE_WRITE_CALL.exec(source);
  while (call !== null) {
    const window = source.slice(call.index, call.index + RUN_CODE_ARG_WINDOW);
    const match = FILE_PATH_ARG.exec(window);
    if (match !== null) {
      // 三种引号各占一个分组，取命中的那个（空串路径按无效处理，交给调用方跳过）
      const value = match[1] ?? match[2] ?? match[3];
      if (typeof value === "string" && value.length > 0) found.push(value);
    }
    call = RUN_CODE_WRITE_CALL.exec(source);
  }
  return found;
}

/**
 * 剥掉块注释与整行行注释——注释里的示例代码不该被当真（收窄误识别面，见 hasDirectMemoryWrite 注释）。
 * 保守取向：误剥只会造成漏识别（该轮提取照跑，无数据损失），所以宁可剥多、不可剥少；
 * 行尾注释不碰（识别它要先做字符串边界解析，得不偿失，且剥错方向是假阴性=安全）。
 */
function stripCodeComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/** resolve 兜底：run_code 里的路径由代码文本切片而来，可能含 NUL 等让 resolve 抛错的字符。 */
function safeResolve(root, rawPath) {
  try {
    return resolve(root, rawPath);
  } catch {
    return ""; // isInsideRoot 对空串判 false，等价于「这不是个可用路径」
  }
}

/**
 * 规格双 skip 条件（顺序：direct-memory-write 优先于 no-user-prose）。
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
      const message = messageOf(event);
      if (isMachineOrigin(message)) continue; // 明确的机器注入不以用户发言身份进摘录
      const text = clip(stripMemoryMarkup(textBlocksOf(message)), maxMessageChars); // 剥自家包裹符防回声
      if (text.length > 0) lines.push(`[seq ${seq}] User: ${text}`);
      continue;
    }
    if (event?.type === "assistant/message") {
      if (!isAppendSurfaceEvent(event)) continue;
      const text = clip(stripMemoryMarkup(textBlocksOf(messageOf(event))), maxMessageChars); // 模型若把注入块回声进回复，剥掉再提取
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
  if (value.length <= max) return value;
  let out = value.slice(0, max);
  // 码点安全：切点落在代理对高位则回退一码点
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return `${out}…`;
}

/**
 * 预算截断保最新、丢最旧：超预算时从尾部保留，并丢弃切割产生的首条残行。
 * 截断时头部加显式标记行（模型可见"前文已省略"），
 * 码点安全切尾（不切出孤立代理对）。
 */
export function clipTail(text, budget) {
  const value = String(text ?? "");
  if (value.length <= budget) return value;
  let tail = value.slice(value.length - budget);
  // 码点安全：尾段首字符若是孤立低位代理（切点正落在代理对中间）则去掉
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  const firstBreak = tail.indexOf("\n");
  const body = firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail;
  return `[...earlier content omitted (extraction backlog truncated)...]\n${body}`;
}
