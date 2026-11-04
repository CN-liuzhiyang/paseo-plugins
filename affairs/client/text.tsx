import { useState, type ReactNode } from "react";
import { Pressable, Text, type TextProps, type TextStyle } from "react-native";
import { WRAP } from "../shared/wrap";

// The only place a Text is made in the panel and the cards. `Words` wraps wherever it has to and gives way to what is
// beside it; `Clip` is a text that may be long: two lines at first, the whole of it when pressed. Anything else that put
// a bare Text in a row would run out of the box again, so test/wrap.test.ts fails on one.

export function Words({ style, ...rest }: TextProps) {
  return <Text {...rest} style={[WRAP as TextStyle, style]} />;
}

export type Piece = { text: string; href?: string };

export function Clip({ text, full, style, lines = 2, hint, open: driven, onOpen, parts, linkColor, onLink }: { text: string; full?: string; style: TextStyle | TextStyle[]; lines?: number; hint?: ReactNode; open?: boolean; onOpen?: (open: boolean) => void; parts?: Piece[]; linkColor?: string; onLink?: (href: string) => void }) {
  const [own, setOwn] = useState(false);
  // On its own it opens and shuts itself; given `open` and `onOpen` the row it is in decides (one press, one thing opening).
  const open = driven ?? own;
  return (
    <Pressable onPress={() => (onOpen ? onOpen(!open) : setOwn(!open))} accessibilityRole="button" accessibilityLabel={open ? "收起" : "展开全文"}>
      <Words style={style} numberOfLines={open ? undefined : lines}>
        {parts?.some((p) => p.href) && onLink && (!open || full === undefined)
          ? parts.map((p, i) =>
              p.href ? (
                <Words key={i} accessibilityRole="link" onPress={() => onLink(p.href!)} style={{ color: linkColor, textDecorationLine: "underline" }}>
                  {p.text}
                </Words>
              ) : (
                p.text
              ),
            )
          : open
            ? (full ?? text)
            : text}
      </Words>
      {open ? hint : null}
    </Pressable>
  );
}
