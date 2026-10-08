// M3 诊断：cwd 分隔符形态对 slug/hash 的影响（临时探针，验后可删）
import { projectMemoryPaths } from "../lib/paths.js";

const root = "C:/Users/user/.dsh/memory";
for (const cwd of [
  "C:\\Users\\user\\Documents\\deepseek-harness\\default-workspace",
  "C:/Users/user/Documents/deepseek-harness/default-workspace",
]) {
  const p = projectMemoryPaths(root, cwd);
  console.log(JSON.stringify(cwd), "=>", p.slug + "-" + p.hash);
}
