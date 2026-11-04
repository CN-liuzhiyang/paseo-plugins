import { useRef, useState } from "react";
import { Image, Modal, Pressable, ScrollView, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { gapOf, zoomByPinch, zoomByWheel } from "../shared/zoom";
import type { Colors } from "../shared/look";
import { Words } from "./text";

// A picture seen big: the whole of it fits the screen; the wheel or two fingers bring it closer and it is moved by dragging.
// A press on the picture, on what is around it, or on 关闭 puts it away.

type Touch = { pageX: number; pageY: number };
type Touches = { nativeEvent: { touches?: ArrayLike<Touch> } };

const HAND = { cursor: "pointer" } as unknown as ViewStyle; // the pointer turns into a hand over what can be pressed (web only; elsewhere ignored)

export function Zoomed({ uri, name, onClose, c }: { uri: string; name: string; onClose: () => void; c: Colors }) {
  const [scale, setScale] = useState(1);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [pinching, setPinching] = useState(false);
  const pinch = useRef<{ gap: number; scale: number } | null>(null);
  const scaleNow = useRef(1);
  const set = (next: number) => {
    scaleNow.current = next;
    setScale(next);
  };
  const onLayout = (e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  const touches = (e: Touches) => Array.from(e.nativeEvent.touches ?? []);
  // The wheel is a web event; the view takes it where the platform has it.
  const wheel = { onWheel: (e: { deltaY: number }) => set(zoomByWheel(scaleNow.current, e.deltaY)) } as object;
  const fingers = {
    onTouchStart: (e: Touches) => {
      const t = touches(e);
      if (t.length >= 2) {
        pinch.current = { gap: gapOf(t[0]!, t[1]!), scale: scaleNow.current };
        setPinching(true);
      }
    },
    onTouchMove: (e: Touches) => {
      const t = touches(e);
      if (t.length >= 2 && pinch.current) set(zoomByPinch(pinch.current.scale, pinch.current.gap, gapOf(t[0]!, t[1]!)));
    },
    onTouchEnd: (e: Touches) => {
      if (touches(e).length < 2) {
        pinch.current = null;
        setPinching(false);
      }
    },
  };
  const w = box.w * scale;
  const h = box.h * scale;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.surface0 }}>
        <Pressable testID="zoom-backdrop" accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }, HAND]} />
        <View testID="zoom-view" onLayout={onLayout} style={{ flex: 1, margin: 12 }} {...wheel} {...fingers}>
          {box.w > 0 ? (
            <ScrollView horizontal scrollEnabled={!pinching} showsHorizontalScrollIndicator={scale > 1} contentContainerStyle={{ width: Math.max(w, box.w), alignItems: "center" }}>
              <ScrollView scrollEnabled={!pinching} showsVerticalScrollIndicator={scale > 1} contentContainerStyle={{ height: Math.max(h, box.h), justifyContent: "center" }}>
                <Pressable testID="zoom-image" accessibilityRole="button" accessibilityLabel={name} onPress={onClose} style={HAND}>
                  <Image source={{ uri }} style={{ width: w, height: h }} resizeMode="contain" />
                </Pressable>
              </ScrollView>
            </ScrollView>
          ) : null}
        </View>
        <Pressable testID="zoom-close" accessibilityRole="button" onPress={onClose} style={[{ position: "absolute", top: 12, right: 12, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border }, HAND]}>
          <Words style={{ color: c.foreground, fontSize: 13 }}>关闭</Words>
        </Pressable>
      </View>
    </Modal>
  );
}
