// 网上的 JSON 文件：取其中几个字段（开关表、版本文件这类只读发布物）
//
// 输入  {"args": {"url": "https://…", "sections": ["greys"], "keys": ["某开关"]}}
//       sections：只看这几段（"" 表示最外层的标量）；keys：只取这几个键的值（缺省取 sections 里全部，最多 40 个）
//       names: true：只要键的名字（"<段>.<键>" 的数组，给别的读取工具当词表用，会超过 1 KB，不适合直接交给 affair read）
// 输出  {"value": {"<段>.<键>": 值, …}, "summary": "一句话"}；键不存在时值是 null，不是错
// 读不到  退出码 1，stderr 一行原因（连不上、HTTP 状态不是 200、不是 JSON）
// 不放时间戳：只取开关的值，文件的更新时间不进 value，所以文件被重新发布但内容没变，不算变了。
const fail = (why) => {
  process.stderr.write(`${why}\n`);
  process.exit(1);
};

const { args = {} } = JSON.parse(await new Promise((resolve) => { let t = ""; process.stdin.on("data", (d) => (t += d)); process.stdin.on("end", () => resolve(t || "{}")); }));
if (typeof args.url !== "string" || !/^https?:\/\//.test(args.url)) fail("要给 url（http 或 https）");

let document;
try {
  const response = await fetch(args.url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
  if (response.status !== 200) fail(`HTTP ${response.status}`);
  document = JSON.parse((await response.text()).replace(/^﻿/, ""));
} catch (error) {
  fail(`读不到：${error.name === "TimeoutError" ? "20 秒没回" : error.message}`.slice(0, 200));
}
if (!document || typeof document !== "object") fail("文件不是 JSON 对象");

const sections = Array.isArray(args.sections) ? args.sections : [""];
const flat = {};
for (const section of sections) {
  if (section === "") {
    for (const [key, value] of Object.entries(document)) if (value === null || typeof value !== "object") flat[key] = value;
    continue;
  }
  const entries = document[section];
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
  for (const [key, value] of Object.entries(entries)) flat[`${section}.${key}`] = value;
}

if (args.names === true) {
  process.stdout.write(JSON.stringify({ value: Object.keys(flat).sort(), summary: `${Object.keys(flat).length} 个键` }));
  process.exit(0);
}
const keys = Array.isArray(args.keys) ? args.keys : null;
const value = {};
if (keys) {
  for (const key of keys.slice(0, 40)) {
    const hit = key in flat ? key : Object.keys(flat).find((k) => k.endsWith(`.${key}`));
    value[key] = hit ? flat[hit] : null;
  }
} else {
  for (const [key, v] of Object.entries(flat).slice(0, 40)) value[key] = v;
}
const found = Object.values(value).filter((v) => v !== null).length;
process.stdout.write(JSON.stringify({ value, summary: keys ? `${keys.length} 个键里 ${found} 个有值：${Object.entries(value).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("，").slice(0, 150)}` : `取到 ${Object.keys(value).length} 个字段` }));
