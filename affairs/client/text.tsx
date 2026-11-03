import { useState, type ReactNode } from "react";
import { Pressable, Text, type TextProps, type TextStyle } from "react-native";
import { WRAP } from "../shared/wrap";

// The only place a Text is made in the panel and the cards. `Words` wraps wherever it has to and gives way to what is
// beside it; `Clip` is a text that may be long: two lines at first, the whole of it when pressed. Anything else that put
// a bare Text in a row would run out of the box again, so test/wrap.test.ts fails on one.

export function Words({ style, ...rest }: TextProps) {
  return <Text {...rest} style={[WRAP as TextStyle, style]} />;
}

export function Clip({ text, full, style, lines = 2, hint }: { text: string; full?: string; style: TextStyle | TextStyle[]; lines?: number; hint?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityLabel={open ? "收起" : "展开全文"}>
      <Words style={style} numberOfLines={open ? undefined : lines}>
        {open ? (full ?? text) : text}
      </Words>
      {open ? hint : null}
    </Pressable>
  );
}
