// dsh-memory 提取失败落盘日志。
//   背景：DSH_MEMORY_DEBUG=1 的 debug.log 是诊断口但默认不开——上游限流提取停摆
//   事故里运行态零痕迹，破案只能拆会话二进制日志。本文件给「失败」单独留一条
//   常开的轻量通道：只记摘要（不附 transcript 前缀，不含会话内容）。
//
// 行格式：[ISO 时间] [pid] reason provider=<p> model=<m> <message 摘要≤200 字符>
// 轮转：>512KB 时先删旧 .1 再 rename（直接 rename 覆盖会丢正在取证的旧档）。
// 并发前提：单进程单写者（dsh-memory 是单入口插件，多会话失败在同一进程内串行
// 追加安全）；跨进程共享 storageRoot（web+desktop 两 profile 同根）不保证，文档已注明。
// 边界：该文件不进备份（createBackup 只拷 global/+settings.json，已实证）、
//   不被 sweepTmpOrphans 清扫（只清 .tmp-/staging，已实证）。
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const ERROR_LOG_NAME = "extraction-errors.log";
const ERROR_LOG_MAX_BYTES = 512 * 1024;

/** 摘要清洗：剥 CR/LF（防注入假行）+ 截 200 字符。纯函数，单测友好。 */
export function sanitizeLogMessage(message) {
  return String(message ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
}

/** 组装一行日志（纯函数）。 */
export function formatErrorLogLine({ at, reason, provider = "", model = "", message = "" }, pid = process.pid) {
  const iso = new Date(at ?? Date.now()).toISOString();
  const route = provider || model ? ` provider=${provider} model=${model}` : "";
  return `[${iso}] [${pid}] ${reason}${route} ${sanitizeLogMessage(message)}\n`;
}

/**
 * 追加一条失败摘要（永不炸主流程——日志失败只落 console，提取管道照常走）。
 * 轮转失败同样静默降级为直接追加（旧档保住总比整条日志口哑掉强）。
 */
export function appendExtractionError(storageRoot, entry) {
  if (typeof storageRoot !== "string" || storageRoot.length === 0) return;
  try {
    const file = join(storageRoot, ERROR_LOG_NAME);
    try {
      if (existsSync(file) && statSync(file).size > ERROR_LOG_MAX_BYTES) {
        const rotated = `${file}.1`;
        if (existsSync(rotated)) rmSync(rotated, { force: true }); // 先删旧档再换，防覆盖丢证
        renameSync(file, rotated);
      }
    } catch {
      /* 轮转失败：直接追加（宁可超一点上限，不丢日志口） */
    }
    appendFileSync(file, formatErrorLogLine(entry), "utf8");
  } catch (error) {
    try {
      console.error(`[dsh-memory] extraction-errors.log 追加失败: ${error?.message ?? error}`);
    } catch { /* 连 console 都炸：彻底放弃（主流程不受影响） */ }
  }
}

/** 测试/面板展示用：日志文件名常量。 */
export { ERROR_LOG_NAME, ERROR_LOG_MAX_BYTES };
