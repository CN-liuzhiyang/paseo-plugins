import { useEffect, useState } from "react";
import { Image, Pressable, View } from "react-native";
import type { PanelEvent } from "../shared/panel";
import { FILTERS, KINDS, filterCounts, tint, type Colors, type FilterId } from "../shared/look";
import { Pieces, openExternal } from "./card";
import { Preview, type Files } from "./files";
import { Dot, Heading } from "./look";
import { Clip, Words, only } from "./text";

// The 经过 block: what happened, newest first, under the day it was. Each row says who (the dot), what it was (the small
// title) and the result in one sentence; pressing a row opens what it stood on and the exact time. The rows are worked out
// by the plugin; this only draws them.

const SHOWN = 4;

function EventRow({ e, c, last, open, onToggle, files }: { e: PanelEvent; c: Colors; last: boolean; open: boolean; onToggle: () => void; files: Files }) {
  const style = KINDS[e.kind];
  const warn = e.tone === "warn";
  const red = e.tone === "red";
  const dotColor = warn ? c.statusWarning : style.color(c);
  const titleColor = warn ? c.statusWarning : style.title(c);
  const muted = { color: c.foregroundMuted, fontSize: 12, lineHeight: 18 } as const;
  const changed = /有变化$/.test(e.sub);
  const names = e.basis?.rows.map((r) => r.name) ?? [];
  // the small picture on a file he sent is the file itself, fetched once
  useEffect(() => {
    for (const f of e.files) if (f.image) files.fetchOnce(f.name, "");
  }, [e.files.map((f) => f.name).join(",")]);
  return (
    <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel={open ? "收起" : "展开"} style={{ flexDirection: "row", gap: 8, paddingBottom: 12, ...(red ? { backgroundColor: tint(c.statusDanger, "1a", c.surface1), borderRadius: 8, marginHorizontal: -6, paddingHorizontal: 6, paddingTop: 6, marginBottom: 6 } : null) }}>
      <View style={{ width: 18, alignItems: "center", paddingTop: 4 }}>
        {!last && !red ? <View style={{ position: "absolute", top: 16, bottom: -14, width: 1.5, backgroundColor: c.border }} /> : null}
        <Dot color={dotColor} size={10} ring={style.dot === "ring"} fill={c.surface0} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <Words style={{ color: titleColor, fontSize: 12, fontWeight: "700", flexShrink: 0 }}>{e.label}</Words>
          <Words style={{ ...muted, flex: 1, ...(changed ? { color: c.accent, fontWeight: "700" } : null) }} numberOfLines={1}>
            {e.sub}
          </Words>
          <Words style={{ ...muted, flexShrink: 0, fontVariant: ["tabular-nums"] }}>{e.when}</Words>
        </View>
        {e.text && !e.bubble ? (
          <View style={{ marginTop: 2, ...(style.bar ? { borderLeftWidth: 2, borderLeftColor: c.accent, paddingLeft: 8 } : null) }}>
            <Clip text={e.text} parts={e.parts} linkColor={c.accent} onLink={openExternal} open={open} onOpen={() => onToggle()} style={{ color: e.calm ? c.foregroundMuted : c.foreground, fontSize: 14, lineHeight: 20, fontWeight: e.strong ? "600" : "400" }} />
          </View>
        ) : null}
        {e.bubble && e.text ? (
          <View style={{ backgroundColor: c.surface2, borderRadius: 12, borderTopLeftRadius: 4, paddingHorizontal: 10, paddingVertical: 6, marginTop: 4, alignSelf: "flex-start", maxWidth: "100%" }}>
            <Pieces text={e.text} parts={e.parts} color={c.accent} style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }} />
          </View>
        ) : null}
        {e.files.map((f) => {
          const place = `e:${e.key}:${f.name}`;
          const got = files.got[`${f.name}|`];
          return (
            <View key={f.name}>
              <Pressable
                onPress={only(() => {
                  files.fetchOnce(f.name, "");
                  files.open(f.name, "", f.path, place);
                })}
                accessibilityRole="button"
                style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", maxWidth: "100%", borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 3, paddingRight: 8, marginTop: 6, backgroundColor: c.surface1 }}
              >
                {f.image && got?.dataUrl ? <Image source={{ uri: got.dataUrl }} style={{ width: 28, height: 28, borderRadius: 5 }} resizeMode="cover" accessibilityLabel={f.shown} /> : null}
                <Words style={{ color: c.foreground, fontSize: 12, flexShrink: 1 }}>{f.shown}</Words>
              </Pressable>
              {files.shownKey === place ? <Preview name={f.name} version="" files={files} c={c} /> : null}
            </View>
          );
        })}
        {e.meta || e.basis || e.next ? (
          <Words style={{ ...muted, marginTop: 3 }}>
            {[e.basis && names.length ? `依据 ${[...new Set(names)].join(" · ")} ${open ? "⌃" : "›"}` : "", e.next ?? "", e.meta ?? ""].filter(Boolean).join("　")}
          </Words>
        ) : null}
        {open ? (
          <View style={{ marginTop: 6, gap: 6 }}>
            {e.children?.length ? (
              <View style={{ paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: c.border, gap: 2 }}>
                {e.children.map((ch, i) => (
                  <Words key={i} style={muted}>
                    {ch.when}　{ch.text}
                  </Words>
                ))}
              </View>
            ) : null}
            {e.basis && (e.basis.rows.length || e.basis.next || e.basis.asked) ? (
              <View style={{ backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 10, gap: 6 }}>
                {e.basis.asked ? <Words style={{ ...muted, color: c.foreground }}>你说：{e.basis.asked}</Words> : null}
                {e.basis.rows.map((r, i) => (
                  <View key={i} style={{ gap: 1 }}>
                    {r.href ? (
                      <Pressable onPress={only(() => openExternal(r.href!))} accessibilityRole="link">
                        <Words style={{ color: c.accent, fontSize: 11, textDecorationLine: "underline" }}>{r.name}</Words>
                      </Pressable>
                    ) : (
                      <Words style={{ color: c.foregroundMuted, fontSize: 11 }}>{r.name}</Words>
                    )}
                    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
                      <Words style={{ ...muted, color: c.foreground, flex: 1 }}>{r.text}</Words>
                      {r.state !== "new" ? <Words style={{ fontSize: 12, flexShrink: 0, color: r.state === "changed" ? c.accent : c.foregroundMuted, fontWeight: r.state === "changed" ? "700" : "400" }}>{r.state === "changed" ? "变了" : "没变"}</Words> : null}
                    </View>
                  </View>
                ))}
                {e.basis.next ? (
                  <View style={{ gap: 1 }}>
                    <Words style={{ color: c.foregroundMuted, fontSize: 11 }}>下次</Words>
                    <Words style={{ ...muted, color: c.foreground }}>{e.basis.next}</Words>
                  </View>
                ) : null}
              </View>
            ) : null}
            <Words style={muted}>{e.whenFull}</Words>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** The block: a heading with "看全部" on its right, the filters once all are open, and the rows under their days. */
export function Timeline({ events, c, files, embedded = false }: { events: PanelEvent[]; c: Colors; files: Files; embedded?: boolean }) {
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState<FilterId>("all");
  const [openKey, setOpenKey] = useState<Record<string, boolean>>({});
  const pick = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
  const rows = all ? events.filter(pick.keep) : events.slice(0, SHOWN);
  const counts = filterCounts(events);
  const link = (text: string, onPress: () => void) => (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Words style={{ color: c.accent, fontSize: 12 }}>{text}</Words>
    </Pressable>
  );
  return (
    <>
      {!embedded ? <Heading text="经过" c={c} /> : null}
      {events.length === 0 ? <Words style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>还没有</Words> : null}
      {all ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {counts
            .filter((f) => f.id === "all" || f.n > 0)
            .map((f) => {
              const on = f.id === filter;
              return (
                <Pressable key={f.id} testID={`filter-${f.id}`} onPress={() => setFilter(f.id)} accessibilityRole="button" style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: on ? c.foreground : c.border, backgroundColor: on ? c.foreground : "transparent" }}>
                  <Words style={{ color: on ? c.surface0 : c.foregroundMuted, fontSize: 12 }}>
                    {f.label} {f.n}
                  </Words>
                </Pressable>
              );
            })}
        </View>
      ) : null}
      {rows.map((e, i) => (
        <View key={e.key}>
          {i === 0 || rows[i - 1].day !== e.day ? <Words style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600", marginTop: i === 0 ? 0 : 10, marginBottom: 6, marginLeft: 26 }}>{e.day}</Words> : null}
          <EventRow e={e} c={c} last={i === rows.length - 1} open={Boolean(openKey[e.key])} onToggle={() => setOpenKey((o) => ({ ...o, [e.key]: !o[e.key] }))} files={files} />
        </View>
      ))}
      {events.length > SHOWN ? (all ? link("收起 ›", () => (setAll(false), setFilter("all"))) : link(`看全部 ${events.length} 条 ›`, () => setAll(true))) : null}
    </>
  );
}
