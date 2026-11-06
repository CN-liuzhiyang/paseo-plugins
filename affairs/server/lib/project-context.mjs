import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ID } from "./log.mjs";
import { keyOfDir, matchesProject } from "./projects.mjs";

export async function projectList(policy, cwd, limit = 5) {
  if (!policy.workDir || !existsSync(policy.workDir)) return "";
  const key = await keyOfDir(cwd, policy);
  const hits = [];
  for (const item of readdirSync(policy.workDir, { withFileTypes: true })) {
    if (!item.isDirectory() || !ID.test(item.name)) continue;
    const file = path.join(policy.workDir, item.name, "status.md");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1];
    if (!header) continue;
    const meta = Object.fromEntries(header.split(/\r?\n/).map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i), JSON.parse(l.slice(i + 1))];
    }));
    if (meta.state !== "open" || !meta.projects.some((project) => matchesProject(key, project))) continue;
    hits.push(`${meta.id} ${meta.title}：${/^现在：(.*)$/m.exec(text)?.[1] || "还没看过"}`);
  }
  if (!hits.length) return "";
  return ["本项目上在进行的事：", ...hits.slice(0, limit), ...(hits.length > limit ? [`还有 ${hits.length - limit} 件：affair here`] : []), "要接手某件：affair attach <编号>"].join("\n");
}

export async function injectProject(policy, request) {
  if (request.env?.AFFAIR_ID || request.labels?.["paseo.schedule-id"] || !request.config.cwd) return;
  const text = await projectList(policy, request.config.cwd);
  if (!text) return;
  return { ...request, config: { ...request.config, systemPrompt: [request.config.systemPrompt, text].filter(Boolean).join("\n\n") } };
}

export async function projectContext(policy, request, log) {
  try { return await injectProject(policy, request); }
  catch (error) { log(`agent.create left unchanged: ${String(error)}`); return; }
}
