import type { PluginOpenScreenInput, PluginScreenProps } from "@getpaseo/plugin/client";
import { RunDetail } from "./run-detail";
import { RunList } from "./run-list";
import { UiProvider } from "./ui";

export const SCREEN_ID = "runs";

/**
 * The sidebar screen: the list of runs, or one run. The run travels in the screen's params, so
 * going back, reloading or coming back from an agent lands on the same run. Read-only throughout.
 */
export function RunsSurface(
  props: PluginScreenProps & { openSettings(): void; openScreen(input: PluginOpenScreenInput): void },
) {
  const runId = props.params.run ?? null;
  const open = (run: string | null) => props.openScreen({ screenId: SCREEN_ID, params: run ? { run } : {} });
  return (
    <UiProvider props={props}>
      {runId === null ? (
        <RunList host={props.host.label} onOpen={open} onSettings={props.openSettings} />
      ) : (
        <RunDetail key={runId} runId={runId} initialSelect={props.params.node ?? null} onBack={() => open(null)} />
      )}
    </UiProvider>
  );
}
