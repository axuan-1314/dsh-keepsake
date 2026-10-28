// 语法检查：对 lib/ 与 tools/ 下所有脚本跑 `node --check`。
// 独立成文件是为了跨平台引号安全——原先那条 node -e 一长串在 pwsh 下很容易被引号吃掉。
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["lib", "tools"];
const failures = [];

for (const dir of targets) {
  for (const file of readdirSync(path.join(root, dir))) {
    if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    const rel = path.join(dir, file);
    try {
      execFileSync(process.execPath, ["--check", path.join(root, rel)], { stdio: "inherit" });
    } catch {
      failures.push(rel);
    }
  }
}

if (failures.length > 0) {
  console.error(`语法检查失败 ${failures.length} 个：${failures.join(", ")}`);
  process.exit(1);
}
console.log(`语法检查通过（${targets.join("/")}，共 ${targets.length} 个目录）`);
