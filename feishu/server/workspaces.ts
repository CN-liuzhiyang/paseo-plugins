import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PaseoApi, PaseoWorkspaceHandle } from "@getpaseo/client";
import type { Route } from "../shared/settings";

export const CHAT_LABEL = "feishu-chat";

export interface WorkspaceAssignments {
  get(chatId: string): Promise<string | null>;
  set(chatId: string, workspaceId: string): Promise<void>;
}

export interface ChatWorkspaces {
  forChat(chatId: string, route: Route): Promise<PaseoWorkspaceHandle>;
}

/** A chat's workspace survives plugin reloads and sessions being archived. */
export function createWorkspaceAssignments(file: string): WorkspaceAssignments {
  let cache: Record<string, string> | null = null;
  let loading: Promise<Record<string, string>> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const load = (): Promise<Record<string, string>> => {
    if (cache) return Promise.resolve(cache);
    if (!loading) {
      loading = (async () => {
        let raw: string;
        try {
          raw = await readFile(file, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return (cache = {});
          throw error;
        }
        const workspaces = (JSON.parse(raw) as { workspaces?: unknown }).workspaces;
        if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces) ||
            Object.entries(workspaces).some(([chatId, id]) => !chatId.startsWith("oc_") || typeof id !== "string")) {
          throw new Error(`${file} has invalid workspace assignments`);
        }
        return (cache = workspaces as Record<string, string>);
      })().finally(() => { loading = null; });
    }
    return loading;
  };

  return {
    get: async (chatId) => (await load())[chatId] ?? null,
    set: (chatId, workspaceId) => {
      const next = queue.then(async () => {
        const workspaces = { ...(await load()), [chatId]: workspaceId };
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ workspaces }, null, 2), { mode: 0o600 });
          await rename(temporary, file);
        } finally {
          await rm(temporary, { force: true });
        }
        cache = workspaces;
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

export function memoryWorkspaceAssignments(): WorkspaceAssignments {
  const workspaces = new Map<string, string>();
  return {
    get: async (chatId) => workspaces.get(chatId) ?? null,
    set: async (chatId, workspaceId) => { workspaces.set(chatId, workspaceId); },
  };
}

export function createChatWorkspaces(deps: {
  paseo: Pick<PaseoApi, "agents" | "workspaces">;
  assignments: WorkspaceAssignments;
  log: (line: string) => void;
}): ChatWorkspaces {
  const titleOf = (route: Route) => `飞书：${route.name.trim() || route.chatId.slice(-8)}`;

  const active = async (workspaceId: string, route: Route): Promise<PaseoWorkspaceHandle | null> => {
    const handle = deps.paseo.workspaces.ref(workspaceId);
    const snapshot = await handle.refresh();
    if (!snapshot || snapshot.archivingAt || !snapshot.workspaceDirectory ||
        path.resolve(snapshot.workspaceDirectory) !== path.resolve(route.cwd)) return null;
    const title = titleOf(route);
    if (snapshot.title !== title) await handle.setTitle(title);
    return handle;
  };

  return {
    async forChat(chatId: string, route: Route): Promise<PaseoWorkspaceHandle> {
      const assigned = await deps.assignments.get(chatId);
      if (assigned) {
        const found = await active(assigned, route);
        if (found) return found;
        deps.log(`workspace ${assigned} for ${chatId} is unavailable or has a different directory`);
      }

      // Adopt the current chat session's workspace when upgrading from the old plugin. If all
      // sessions were archived, their labels still point back to the chat's last workspace.
      const query = {
        sort: [{ key: "created_at" as const, direction: "desc" as const }],
        page: { limit: 50 },
      };
      const current = await deps.paseo.agents.list({
        ...query,
        filter: { labels: { [CHAT_LABEL]: chatId } },
      });
      const history = current.entries.length === 0
        ? await deps.paseo.agents.list({
            ...query,
            filter: { labels: { [CHAT_LABEL]: chatId }, includeArchived: true },
          })
        : null;
      const entries = history?.entries ?? current.entries;
      for (const { agent } of entries) {
        if (!agent.workspaceId || agent.workspaceId === assigned) continue;
        const found = await active(agent.workspaceId, route);
        if (!found) continue;
        await deps.assignments.set(chatId, found.id);
        deps.log(`adopted workspace ${found.id} for ${chatId}`);
        return found;
      }

      const created = await deps.paseo.workspaces.create({
        source: { kind: "directory", path: path.resolve(route.cwd) },
        title: titleOf(route),
      });
      await deps.assignments.set(chatId, created.id);
      deps.log(`created workspace ${created.id} for ${chatId}`);
      return created;
    },
  };
}
