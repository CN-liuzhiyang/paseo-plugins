import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PanResponder, Platform, View, type ViewStyle } from "react-native";
import { clampDrawerWidth, DRAWER_DEFAULT } from "./sizes";
import { useUi } from "./ui";

// The detail drawer, wide or narrow as the person drags its left edge. Modeled on Paseo's own
// right-hand rail (TreeRail with SidebarResizeHandle): a 10px grab strip straddling the border,
// a hairline after 100ms of hover, the width following the pointer and kept on release, one
// width for the whole app on this device. Plugins get neither gesture-handler nor reanimated,
// so the drag is React Native's PanResponder.

const HANDLE = 10;
const HIGHLIGHT_DELAY_MS = 100;
const KEY = "orchestration-ui:drawer-width";

let remembered: number | null = null;

/** The width last chosen on this device; web and desktop keep it in localStorage, native in memory. */
export function readDrawerWidth(): number {
  if (remembered !== null) return remembered;
  try {
    const stored = Number(globalThis.localStorage?.getItem(KEY));
    if (Number.isFinite(stored) && stored > 0) remembered = stored;
  } catch {
    // Storage may be unavailable; the width then lasts for this session.
  }
  return remembered ?? DRAWER_DEFAULT;
}

function writeDrawerWidth(width: number): void {
  remembered = width;
  try {
    globalThis.localStorage?.setItem(KEY, String(width));
  } catch {
    // As above.
  }
}

const resizeCursor = (Platform.OS === "web" ? { cursor: "col-resize" } : {}) as ViewStyle;

/** Hover and pointer props React Native Web passes to the DOM; typed here as the DOM has them. */
type HoverProps = { onPointerEnter?: () => void; onPointerLeave?: () => void };
type DomPointer = {
  preventDefault(): void;
  currentTarget: { setPointerCapture?(pointerId: number): void };
  nativeEvent: { pointerId: number; clientX: number };
};
type PointerProps = {
  onPointerDown(event: DomPointer): void;
  onPointerMove(event: DomPointer): void;
  onPointerUp(): void;
  onPointerCancel(): void;
};

export function ResizableDrawer({ containerWidth, children }: { containerWidth: number; children: ReactNode }) {
  const ui = useUi();
  const c = ui.theme.colors;
  const [width, setWidth] = useState(readDrawerWidth);
  const [dragging, setDragging] = useState(false);
  const [highlighted, setHighlighted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef(width);
  const latest = useRef(width);
  const visible = clampDrawerWidth(width, containerWidth);
  latest.current = visible;

  useEffect(() => () => clearTimeout(timer.current), []);

  const begin = () => {
    start.current = latest.current;
    setDragging(true);
  };
  // Dragging left widens: the drawer's left edge follows the pointer.
  const move = (dx: number) => setWidth(clampDrawerWidth(start.current - dx, containerWidth));
  const finish = () => {
    setDragging(false);
    writeDrawerWidth(latest.current);
  };

  // Native: the responder system. Not on the web: React Native Web ends a responder as soon as
  // the browser starts selecting text, which a drag across the drawer always does.
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: begin,
        onPanResponderMove: (_event, gesture) => move(gesture.dx),
        onPanResponderRelease: finish,
        onPanResponderTerminate: finish,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [containerWidth],
  );
  // Web: pointer events, captured by the handle so the drag survives leaving its 10px, with the
  // default (text selection) prevented.
  const originX = useRef<number | null>(null);
  const pointer: PointerProps = {
    onPointerDown: (event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.nativeEvent.pointerId);
      originX.current = event.nativeEvent.clientX;
      begin();
    },
    onPointerMove: (event) => {
      if (originX.current !== null) move(event.nativeEvent.clientX - originX.current);
    },
    onPointerUp: () => {
      if (originX.current === null) return;
      originX.current = null;
      finish();
    },
    onPointerCancel: () => {
      if (originX.current === null) return;
      originX.current = null;
      finish();
    },
  };

  const hover: HoverProps = {
    onPointerEnter: () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setHighlighted(true), HIGHLIGHT_DELAY_MS);
    },
    onPointerLeave: () => {
      clearTimeout(timer.current);
      setHighlighted(false);
    },
  };

  return (
    <View style={{ width: visible, borderLeftWidth: 1, borderLeftColor: c.border, backgroundColor: c.surface1 }}>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 48 }}>{children}</ScrollView>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel="拖动调整详情栏宽度"
        {...(Platform.OS === "web" ? (pointer as object) : responder.panHandlers)}
        {...(hover as object)}
        style={[{ position: "absolute", top: 0, bottom: 0, left: -HANDLE / 2, width: HANDLE, zIndex: 10 }, resizeCursor]}
      >
        {highlighted || dragging ? (
          <View
            pointerEvents="none"
            style={{ position: "absolute", top: 0, bottom: 0, left: HANDLE / 2, width: 1, backgroundColor: c.foreground, opacity: 0.25 }}
          />
        ) : null}
      </View>
    </View>
  );
}
