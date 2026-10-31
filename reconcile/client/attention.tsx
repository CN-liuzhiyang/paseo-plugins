import { useRpc, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { attentionRpc } from "../shared/rpc";
import { countLabel } from "../shared/status";
import { SCREEN_ID } from "./screen";

// The sidebar's one row, "事项追踪", with the number of things waiting for the person on it. It stands where the cards' workspace used
// to stand in the sidebar (the workspace is in the background now): the number is what says, without opening anything, that there is a
// question to answer. Zero shows nothing. A number that cannot be read is left as it was, never shown as zero.

const POLL_MS = 10_000;

/** The count, asked every POLL_MS; null until the first answer, and kept when an ask fails. */
export function useAttention(): number | null {
  const attention = useRpc(attentionRpc);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { count: n } = await attention({});
        if (!cancelled) setCount(n);
      } catch {
        // Not read this time: what is shown stays, and the next ask tries again.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attention]);
  return count;
}

export function CountBadge({ count, theme }: { count: number; theme: PluginSidebarItemProps["theme"] }) {
  const c = theme.colors;
  return (
    <View accessibilityLabel={`事项追踪 · ${count}`} style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: c.statusWarning, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: c.surface0, fontSize: 11, fontWeight: "700" }}>{countLabel(count)}</Text>
    </View>
  );
}

export function InboxRow({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const count = useAttention();
  return <SidebarRow icon="Inbox" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} trailing={count ? <CountBadge count={count} theme={theme} /> : undefined} />;
}
