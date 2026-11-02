// 测试用：从 args.file 读出该返回什么（{ mode: "ok" | "down", value, summary }），并记一次被读
import { appendFileSync, readFileSync } from "node:fs";

const { args } = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(`${args.file}.count`, "x");
const spec = JSON.parse(readFileSync(args.file, "utf8"));
if (spec.mode === "down") {
  process.stderr.write("崩溃库连不上，要开 VPN\n");
  process.exit(3);
}
process.stdout.write(JSON.stringify({ value: spec.value, summary: spec.summary ?? "读到了" }));
