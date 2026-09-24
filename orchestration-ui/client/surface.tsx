import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { RunDetail } from "./run-detail";
import { RunList } from "./run-list";
import { UiProvider } from "./ui";

/** The sidebar surface: the list of runs, or one run. Read-only throughout. */
export function RunsSurface(props: PluginSurfaceProps & { openSettings(): void }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <UiProvider props={props}>
      {selected === null ? (
        <RunList host={props.host.label} onOpen={setSelected} onSettings={props.openSettings} />
      ) : (
        <RunDetail key={selected} runId={selected} onBack={() => setSelected(null)} />
      )}
    </UiProvider>
  );
}
