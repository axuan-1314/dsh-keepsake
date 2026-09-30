// paths：slug/hash16 算法（规格：basename 净化截 48 / 绝对路径小写 sha256 前 16）
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { hashProjectPath, projectMemoryPaths, slugifyBasename } from "../lib/paths.js";

test("slugifyBasename: 基本净化", () => {
  assert.equal(slugifyBasename("My App"), "my-app");
  assert.equal(slugifyBasename("workspace"), "project"); // 非法字符全替换后为空
  assert.equal(slugifyBasename("another-plugin"), "another-plugin");
  assert.equal(slugifyBasename("My Cool App!"), "my-cool-app");
});

test("slugifyBasename: 截 48 与空值", () => {
  assert.equal(slugifyBasename("x".repeat(100)).length, 48);
  assert.equal(slugifyBasename(""), "project");
  assert.equal(slugifyBasename("!!!"), "project");
  assert.equal(slugifyBasename(undefined), "project");
});

test("hashProjectPath: sha256 前 16 hex，win32 小写化", () => {
  const expected = createHash("sha256").update("d:\\projects\\my app", "utf8").digest("hex").slice(0, 16);
  if (process.platform === "win32") {
    assert.equal(hashProjectPath("D:\\Projects\\My App"), expected);
  } else {
    assert.equal(hashProjectPath("d:\\projects\\my app"), expected);
    assert.equal(hashProjectPath("D:\\Projects\\My App"), createHash("sha256").update("D:\\Projects\\My App", "utf8").digest("hex").slice(0, 16));
  }
  assert.equal(/^[0-9a-f]{16}$/.test(hashProjectPath("/tmp/x")), true);
});

test("projectMemoryPaths: 布局 <root>/projects/<slug>-<hash>/memory", () => {
  const paths = projectMemoryPaths("C:\\Users\\user\\.dsh\\memory", "D:\\my-app");
  const hash = hashProjectPath("D:\\my-app");
  assert.equal(paths.slug, "project");
  assert.ok(paths.projectDir.includes(`projects\\project-${hash}`) || paths.projectDir.includes(`projects/project-${hash}`));
  assert.ok(paths.memoryDir.endsWith("memory"));
  // 同一 cwd 不同大小写（win32）→ 同一目录
  const paths2 = projectMemoryPaths("C:\\Users\\user\\.dsh\\memory", "D:\\MYAPP...");
  if (process.platform === "win32") {
    assert.equal(paths2.slug, "myapp");
  }
});
