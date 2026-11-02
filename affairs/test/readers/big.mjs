// 测试用：value 超过 1 KB
process.stdout.write(JSON.stringify({ value: "x".repeat(2000), summary: "太大" }));
