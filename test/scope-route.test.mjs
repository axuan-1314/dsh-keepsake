// scope-route：提取 ops 的 scope 协议路由。
//   未知 scope 显式 skip+warn；global 开关关过滤计数；project 开关关过滤计数；
//   recent-activity host 盖 timestamp；project ops 走项目根原逻辑。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyScopedOps, parseExtractionOutput, buildExtractionPayload, VALID_SCOPES } from "../lib/extract.js";
import { categoryDir, listEntries, readEntry } from "../lib/global-store.js";

function freshRoot() {
  const storageRoot = mkdtempSync(join(tmpdir(), "dsh-keepsake-scope-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "dsh-keepsake-proj-"));
  return { storageRoot, projectRoot };
}

const WRITE_OP = {
  action: "write",
  name: "fact.md",
  type: "project",
  title: "Fact",
  description: "d",
  content: "正文",
};

test("parseExtractionOutput：scope 缺省 project；显式 scope 保留", () => {
  const parsed = parseExtractionOutput(JSON.stringify({
    ops: [
      { action: "write", name: "a.md", content: "一" },
      { action: "write", name: "b.md", scope: "global:work-profile", content: "二" },
      { action: "delete", name: "c.md", scope: "global:long-term" },
    ],
  }));
  assert.equal(parsed.kind, "ops");
  assert.equal(parsed.ops[0].scope, "project");
  assert.equal(parsed.ops[1].scope, "global:work-profile");
  assert.equal(parsed.ops[2].scope, "global:long-term");
});

test("VALID_SCOPES：project + 五个 global 分类", () => {
  assert.equal(VALID_SCOPES.size, 6);
  assert.ok(VALID_SCOPES.has("project"));
  assert.ok(VALID_SCOPES.has("global:recent-activity"));
  assert.ok(VALID_SCOPES.has("global:long-term"));
});

test("applyScopedOps：project op 走项目根（v0.1.0 原逻辑）", () => {
  const { storageRoot, projectRoot } = freshRoot();
  try {
    const result = applyScopedOps({ storageRoot, projectRoot }, [{ ...WRITE_OP }], {});
    assert.equal(result.writes, 1);
    assert.equal(existsSync(join(projectRoot, "fact.md")), true);
    assert.match(readFileSync(join(projectRoot, "MEMORY.md"), "utf8"), /- \[Fact\]/);
    assert.equal(result.byScope.project.writes, 1);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("applyScopedOps：global op 走全局分类根（type: global 落盘）", () => {
  const { storageRoot, projectRoot } = freshRoot();
  try {
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { ...WRITE_OP, scope: "global:work-profile" },
    ], {});
    assert.equal(result.writes, 1);
    const entry = readEntry(storageRoot, "work-profile", "fact.md");
    assert.ok(entry);
    assert.equal(entry.content, "正文");
    const raw = readFileSync(join(categoryDir(storageRoot, "work-profile"), "fact.md"), "utf8");
    assert.match(raw, /type: global/);
    assert.equal(existsSync(join(projectRoot, "fact.md")), false); // 不写项目根
    assert.equal(result.byScope["global:work-profile"].writes, 1);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("applyScopedOps：recent-activity 写入 host 盖 timestamp（不信模型报时）", () => {
  const { storageRoot, projectRoot } = freshRoot();
  try {
    const before = Date.now();
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { ...WRITE_OP, scope: "global:recent-activity" },
    ], {});
    assert.equal(result.writes, 1);
    const entry = readEntry(storageRoot, "recent-activity", "fact.md");
    const ts = Date.parse(entry.timestamp);
    assert.ok(Number.isFinite(ts) && ts >= before - 1000, "timestamp 应为 host 落盘时刻");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("applyScopedOps：未知 scope 显式 skip + warn（不炸整批，好 op 照落）", () => {
  const { storageRoot, projectRoot } = freshRoot();
  try {
    const warns = [];
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { ...WRITE_OP, name: "good.md" },
      { ...WRITE_OP, name: "bad.md", scope: "global:nonsense" },
      { ...WRITE_OP, name: "bad2.md", scope: "somewhere-else" },
    ], { log: { warn: (m) => warns.push(m) } });
    assert.equal(result.writes, 1); // good.md 落盘
    assert.equal(result.unknownScope, 2);
    assert.equal(warns.length, 2);
    assert.match(warns[0], /未知 scope/);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("applyScopedOps：allowGlobal=false → global ops 过滤计数，project 照落", () => {
  const { storageRoot, projectRoot } = freshRoot();
  try {
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { ...WRITE_OP, name: "proj.md" },
      { ...WRITE_OP, name: "g1.md", scope: "global:work-profile" },
      { ...WRITE_OP, name: "g2.md", scope: "global:long-term" },
    ], { allowGlobal: false });
    assert.equal(result.writes, 1);
    assert.equal(result.filteredGlobal, 2);
    assert.equal(countGlobal(storageRoot), 0);
    assert.equal(existsSync(join(projectRoot, "proj.md")), true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

function countGlobal(storageRoot) {
  return ["work-profile", "user-profile", "current-focus", "recent-activity", "long-term"]
    .reduce((acc, id) => acc + listEntries(storageRoot, id).length, 0);
}

test("applyScopedOps：allowProject=false → project ops 过滤计数，global 照落", () => {
  const { storageRoot, projectRoot } = freshRoot();
  try {
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { ...WRITE_OP, name: "proj.md" },
      { ...WRITE_OP, name: "g.md", scope: "global:work-profile" },
    ], { allowProject: false });
    assert.equal(result.writes, 1);
    assert.equal(result.filteredProject, 1);
    assert.equal(existsSync(join(projectRoot, "proj.md")), false);
    assert.equal(readEntry(storageRoot, "work-profile", "g.md") !== null, true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("applyScopedOps：global delete op 删除全局条目", () => {
  const { storageRoot, projectRoot } = freshRoot();
  try {
    applyScopedOps({ storageRoot, projectRoot }, [{ ...WRITE_OP, scope: "global:long-term" }], {});
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { action: "delete", name: "fact.md", scope: "global:long-term" },
    ], {});
    assert.equal(result.deletes, 1);
    assert.equal(readEntry(storageRoot, "long-term", "fact.md"), null);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("applyScopedOps：global write 非法文件名计数 skipped（三道闸）", () => {
  const { storageRoot, projectRoot } = freshRoot();
  try {
    const warns = [];
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { ...WRITE_OP, name: "../evil.md", scope: "global:work-profile" },
    ], { log: { warn: (m) => warns.push(m) } });
    assert.equal(result.writes, 0);
    assert.equal(result.skipped, 1);
    assert.equal(warns.length, 1);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("applyScopedOps：混合一批（project + 多分类）byScope 分项计数", () => {
  const { storageRoot, projectRoot } = freshRoot();
  try {
    const result = applyScopedOps({ storageRoot, projectRoot }, [
      { ...WRITE_OP, name: "p.md" },
      { ...WRITE_OP, name: "w.md", scope: "global:work-profile" },
      { ...WRITE_OP, name: "u.md", scope: "global:user-profile" },
      { ...WRITE_OP, name: "r.md", scope: "global:recent-activity" },
    ], {});
    assert.equal(result.writes, 4);
    assert.equal(result.byScope.project.writes, 1);
    assert.equal(result.byScope["global:work-profile"].writes, 1);
    assert.equal(result.byScope["global:user-profile"].writes, 1);
    assert.equal(result.byScope["global:recent-activity"].writes, 1);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("buildExtractionPayload：全局 manifest 与 scope 契约进 prompt", () => {
  const { system } = buildExtractionPayload({
    transcript: "t",
    manifest: "",
    bodies: "",
    memoryRoot: "/x",
    globalManifest: "### 工作背景\n- [A](a.md)",
  });
  assert.match(system, /global:work-profile/);
  assert.match(system, /global:recent-activity/);
  assert.match(system, /### 工作背景/);
  assert.match(system, /"scope":"project"/);
  assert.match(system, /Current global memory state/);
});

test("buildExtractionPayload：无全局数据时显式标注 empty", () => {
  const { system } = buildExtractionPayload({ transcript: "t", manifest: "", bodies: "", memoryRoot: "/x" });
  assert.match(system, /\(empty — no global memories yet\)/);
});
