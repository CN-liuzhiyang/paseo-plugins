import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PaseoApi, PaseoWorkspaceHandle } from "@getpaseo/client";
import type { Carrier } from "./engine";
import { cardPrompt, MODEL_ID, PROVIDER_ID } from "./inbox";

// Cards live in one workspace of their own, "事务", so the sidebar under it is the list of
// questions waiting for an answer: each carrier agent is titled with its question and shows
// as needing attention until answered, then the engine archives it.

export const CARD_LABEL = "reconcile-card";
const TITLE = "事务";

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
      const snapshot = await handle.refresh().catch(() => null);
      if (snapshot && !snapshot.archivingAt && snapshot.workspaceDirectory && path.resolve(snapshot.workspaceDirectory) === path.resolve(deps.workspaceDir)) return handle;
      deps.log(`workspace ${known} is gone or moved; making a new one`);
    }
    mkdirSync(deps.workspaceDir, { recursive: true });
    const created = await deps.paseo.workspaces.create({ source: { kind: "directory", path: path.resolve(deps.workspaceDir) }, title: TITLE });
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
  };
}
