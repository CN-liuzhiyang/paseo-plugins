import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, View, type ViewStyle } from "react-native";
import type { PanelData, PanelMaterial } from "../shared/panel";
import { fileRpc } from "../shared/rpc";
import type { Colors } from "../shared/look";
import { Rule, Tag } from "./look";
import { Words } from "./text";
import { Zoomed } from "./zoom";

// The 资料 block: one row for each file in the affair's folder. Pressing a file opens it where the host can show it (a tab
// of its own in the workspace, when the host has one to give); a host that has not (a phone's web page, an older app)
// shows it right here under its row. Pictures are drawn as thumbnails, fetched once for each file as it stands.

type Opener = ((input: { workspaceId: string; path: string }) => void) | undefined;

type Got = { kind: "image" | "text" | "other"; dataUrl?: string; text?: string; truncated: boolean; size: number; path: string; ok: boolean };

/** What the files of one workspace's affair give, kept for the life of the panel: asked for once each, never again while it is the same file. */
export function useFiles(workspaceId: string, openFile: Opener) {
  const ask = useRpc(fileRpc);
  const [got, setGot] = useState<Record<string, Got>>({});
  const asked = useRef(new Set<string>());
  const [opened, setOpened] = useState<string | null>(null); // the file last sent to the host (its row stays marked)
  const [shownKey, setShownKey] = useState<string | null>(null); // the place that has its preview open here

  const fetchOnce = useCallback(
    (name: string, version: string) => {
      const key = `${name}|${version}`;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      void ask({ workspaceId, name })
        .then((r) => setGot((g) => ({ ...g, [key]: r })))
        .catch(() => asked.current.delete(key));
    },
    [workspaceId, ask],
  );

  return {
    got,
    fetchOnce,
    opened,
    shownKey,
    canOpen: typeof openFile === "function",
    openPath: typeof openFile === "function" ? (path: string) => openFile({ workspaceId, path }) : undefined,
    /** Press on a file: the host's tab when it has one, else the preview under `place`. */
    open(name: string, version: string, path: string, place: string) {
      if (typeof openFile === "function") {
        setOpened(name);
        openFile({ workspaceId, path });
        return;
      }
      fetchOnce(name, version);
      setShownKey(shownKey === place ? null : place);
    },
  };
}
export type Files = ReturnType<typeof useFiles>;

/** Open the introduction in the host's README tab, or expand it here on older hosts. */
export function What({ what, files, c }: { what: NonNullable<PanelData["what"]>; files: Pick<Files, "openPath">; c: Colors }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Pressable testID="panel-what" accessibilityRole="button" accessibilityLabel={files.openPath ? "打开 README" : expanded ? "收起" : "展开全文"} onPress={() => files.openPath ? files.openPath(what.path) : setExpanded(!expanded)} style={{ marginHorizontal: 16, marginTop: 14, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, backgroundColor: c.surface1 }}>
      <Words numberOfLines={expanded ? undefined : 3} style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}>{what.text}</Words>
      <Words style={{ color: c.accent, fontSize: 12, lineHeight: 18, textAlign: "right", marginTop: 4 }}>{expanded ? "收起" : "README ›"}</Words>
    </Pressable>
  );
}

/** The picture of a thumbnail: the file's own when it came, else a block with its type. */
export function Thumb({ item, got, c, size = 44 }: { item: { name: string; ext: string; thumb: boolean; version: string }; got?: Got; c: Colors; size?: number }) {
  if (item.thumb && got?.dataUrl) return <Image source={{ uri: got.dataUrl }} style={{ width: size, height: size, borderRadius: 8, borderWidth: 1, borderColor: c.border, flexShrink: 0 }} resizeMode="cover" accessibilityLabel={item.name} />;
  return (
    <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <Words style={{ color: c.foregroundMuted, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 }}>{item.ext || "文件"}</Words>
    </View>
  );
}

/** The file shown under its row, for a host that cannot open it in a tab: the picture, the text, or what it is. */
export function Preview({ name, version, files, c }: { name: string; version: string; files: Files; c: Colors }) {
  const got = files.got[`${name}|${version}`];
  const [big, setBig] = useState(false);
  const [ratio, setRatio] = useState(1.5);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (got?.dataUrl) Image.getSize(got.dataUrl, (w, h) => h > 0 && setRatio(w / h), () => {});
  }, [got?.dataUrl]);
  const box = { backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 6 } as const;
  const act = (text: string, onPress: () => void) => (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Words style={{ color: c.accent, fontSize: 12 }}>{text}</Words>
    </Pressable>
  );
  const copy = (path: string) => {
    const clip = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator?.clipboard;
    void clip?.writeText?.(path).then(() => setCopied(true)).catch(() => {});
  };
  if (!got) return <View style={box}><Words style={{ color: c.foregroundMuted, fontSize: 12 }}>…</Words></View>;
  if (!got.ok) return <View style={box}><Words style={{ color: c.foregroundMuted, fontSize: 12 }}>没有这个文件。</Words></View>;
  const bar = (
    <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
      {act(copied ? "已复制" : "复制路径", () => copy(got.path))}
    </View>
  );
  return (
    <View style={box}>
      {got.kind === "image" && got.dataUrl ? (
        <>
          <Pressable testID="preview-image" accessibilityRole="button" accessibilityLabel={name} onPress={() => setBig(true)} style={{ cursor: "pointer" } as ViewStyle}>
            <Image source={{ uri: got.dataUrl }} style={{ width: "100%", aspectRatio: ratio, maxHeight: 280, borderRadius: 4 }} resizeMode="contain" />
          </Pressable>
          {big ? <Zoomed uri={got.dataUrl} name={name} onClose={() => setBig(false)} c={c} /> : null}
        </>
      ) : got.kind === "text" ? (
        <Words selectable style={{ color: c.foreground, fontSize: 12, lineHeight: 17 }}>
          {got.text}
          {got.truncated ? "\n…（只显示前面一部分）" : ""}
        </Words>
      ) : (
        <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{got.kind === "image" ? "这张图太大，这里不显示。" : "这种文件这里看不了。"}</Words>
      )}
      {bar}
      {got.kind === "other" || (got.kind === "image" && !got.dataUrl) ? (
        <Words selectable style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 16, marginTop: 6 }}>
          {got.path}
        </Words>
      ) : null}
    </View>
  );
}

/** The 资料 rows. */
export function Materials({ items, more, files, c }: { items: PanelMaterial[]; more: number; files: Files; c: Colors }) {
  useEffect(() => {
    for (const m of items) if (m.thumb) files.fetchOnce(m.name, m.version);
  }, [items.map((m) => `${m.name}|${m.version}`).join(",")]);
  return (
    <>
      {items.length === 0 ? <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>还没有</Words> : null}
      {items.map((m, i) => {
        const place = `m:${m.name}`;
        const on = files.shownKey === place || (files.canOpen && files.opened === m.name);
        return (
          <View key={m.name}>
            {i > 0 ? <Rule c={c} /> : null}
            <Pressable
              testID={`material-${m.name}`}
              accessibilityRole="button"
              onPress={() => files.open(m.name, m.version, m.path, place)}
              style={{ flexDirection: "row", gap: 10, alignItems: "center", paddingVertical: 4, paddingHorizontal: 4, marginHorizontal: -4, borderRadius: 8, backgroundColor: on ? c.surface2 : "transparent" }}
            >
              <Thumb item={m} got={files.got[`${m.name}|${m.version}`]} c={c} />
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Words style={{ color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{m.shown}</Words>
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                  <Tag text={m.who} c={c} color={m.who === "你发的" ? c.foreground : undefined} />
                  <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
                    {m.size} · {m.at}
                  </Words>
                </View>
              </View>
              <Words style={{ color: c.foregroundMuted, fontSize: 16, flexShrink: 0 }}>›</Words>
            </Pressable>
            {files.shownKey === place ? <Preview name={m.name} version={m.version} files={files} c={c} /> : null}
          </View>
        );
      })}
      {more ? <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, marginTop: 6 }}>还有 {more} 个</Words> : null}
    </>
  );
}
