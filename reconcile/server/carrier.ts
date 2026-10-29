import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PaseoApi, PaseoWorkspaceHandle } from "@getpaseo/client";
import type { Carrier } from "./engine";
import { cardPrompt, MODEL_ID, PROVIDER_ID } from "./inbox";

// Cards live in one workspace of their own, "事项追踪", made in the background (2026-10-29): it is not in the
// sidebar, which instead has one row, "事项追踪", with the number of things waiting for the person on it. Each
// carrier agent is titled with its question and still raises the app's notification (and the phone's) when its
// question comes up -- that does not look at whether the workspace is in the background -- and the engine
// archives it once answered.

export const CARD_LABEL = "reconcile-card";
const TITLE = "事项追踪";
/** The workspace's name before 2026-10-23: renamed to TITLE. A name a person gave it is theirs. */
const OLD_TITLES = ["事务"];

const samePath = (a: string, b: string) => {
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};

export function createCarrier(deps: {
  paseo: Pick<PaseoApi, "workspaces" | "agents">;
  workspaceDir: string;
  workspaceId(): string | null;
  rememberWorkspace(id: string): void;
  log(message: string): void;
}): Carrier {
  async function workspace(): Promise<PaseoWorkspaceHandle> {
    const known = deps.workspaceId();
    if (known) {
      const handle = deps.paseo.workspaces.ref(known);
      // A failure to look is not a workspace gone: it throws, and this card waits for the next try.
      const snapshot = await handle.refresh();
      if (snapshot && !snapshot.archivingAt && snapshot.workspaceDirectory && samePath(snapshot.workspaceDirectory, deps.workspaceDir)) {
        // Whether a workspace is in the background is decided when it is made and cannot be changed. One made before this was (visible, in
        // the sidebar) is replaced by a background one: the host does not hand out the old one for the same directory (checked 2026-10-29),
        // so a new one is made and the old one is left to be archived by a person. Cards still in the old one are answered where they are
        // (they are tracked by their agents, not by the workspace). `background` absent: a host that does not say, kept as it is.
        if (snapshot.background !== false) {
          // The same workspace keeps its cards when the name changes: renamed, not replaced.
          if (OLD_TITLES.includes(snapshot.title ?? "")) {
            await handle.setTitle(TITLE).catch((error: unknown) => deps.log(`renaming workspace ${known} failed: ${(error as Error).message}`));
          }
          return handle;
        }
        deps.log(`workspace ${known} is visible in the sidebar; making a background one for the cards from now on`);
        const replacement = await create().catch((error: unknown) => {
          // The cards still have somewhere to go: the old one is used as it is, and this is tried again at the next card.
          deps.log(`making a background workspace failed, using the visible one ${known}: ${(error as Error).message}`);
          return null;
        });
        return replacement ?? handle;
      }
      deps.log(`workspace ${known} is gone or moved; making a new one`);
    }
    return create();
  }

  async function create(): Promise<PaseoWorkspaceHandle> {
    mkdirSync(deps.workspaceDir, { recursive: true });
    const created = await deps.paseo.workspaces.create({ source: { kind: "directory", path: path.resolve(deps.workspaceDir) }, title: TITLE, background: true });
    deps.rememberWorkspace(created.id);
    return created;
  }

  return {
    async raise(card, _content, attempt) {
      const handle = await workspace();
      const agent = await handle.agents.create({
        agentId: randomUUID(),
        idempotencyKey: `reconcile:${card.id}:${attempt}`,
        title: card.title.length > 80 ? `${card.title.slice(0, 79)}…` : card.title,
        config: { provider: `${PROVIDER_ID}/${MODEL_ID}` },
        labels: { source: "reconcile", [CARD_LABEL]: card.id },
        prompt: cardPrompt(card.id),
      });
      return agent.id;
    },
    async archive(agentId) {
      await deps.paseo.agents.ref(agentId).archive();
    },
    async ensure() {
      await workspace();
    },
  };
}
