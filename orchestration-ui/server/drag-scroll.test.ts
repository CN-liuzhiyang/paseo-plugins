import assert from "node:assert/strict";
import { test } from "node:test";
import { attachDragScroll, DRAG_THRESHOLD, wheelToSideways, type ScrollableNode } from "../client/drag-scroll";

// A stand-in for the element: it keeps the listeners and says what the scroll position came to; events are handed to them as they come.

function fake(size = { scrollWidth: 2000, clientWidth: 600, scrollHeight: 300, clientHeight: 300 }) {
  const listeners = new Map<string, Array<{ fn: (e: any) => void; capture: boolean }>>();
  const node = {
    scrollLeft: 0,
    scrollTop: 0,
    ...size,
    style: { cursor: "", userSelect: "" },
    captured: [] as number[],
    addEventListener(type: string, fn: (e: any) => void, options?: boolean | { capture?: boolean }) {
      const capture = options === true || (typeof options === "object" && options?.capture === true);
      listeners.set(type, [...(listeners.get(type) ?? []), { fn, capture }]);
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l.fn !== fn));
    },
    setPointerCapture(id: number) {
      node.captured.push(id);
    },
    releasePointerCapture() {},
  };
  const fire = (type: string, event: Record<string, unknown> = {}) => {
    const e = {
      preventDefault() {
        e.prevented = true;
      },
      stopPropagation() {
        e.stopped = true;
      },
      prevented: false,
      stopped: false,
      ...event,
    } as any;
    for (const l of listeners.get(type) ?? []) l.fn(e);
    return e;
  };
  return { node: node as ScrollableNode & typeof node, fire, count: (type: string) => (listeners.get(type) ?? []).length };
}
const mouse = (x: number, y = 0, extra: Record<string, unknown> = {}) => ({ pointerType: "mouse", button: 0, pointerId: 1, clientX: x, clientY: y, ...extra });

test("a press and a pull moves the picture the other way, and the click that ends it is not a click", async () => {
  const { node, fire } = fake();
  attachDragScroll(node);
  assert.equal(node.style.cursor, "grab", "a hand to take it by");
  fire("pointerdown", mouse(300));
  assert.equal(node.style.userSelect, "none", "no text is picked up while pulling");
  fire("pointermove", mouse(250));
  assert.equal(node.scrollLeft, 50);
  assert.equal(node.style.cursor, "grabbing");
  assert.deepEqual(node.captured, [1]);
  fire("pointermove", mouse(100));
  assert.equal(node.scrollLeft, 200);
  fire("pointerup", mouse(100));
  assert.equal(node.style.cursor, "grab");
  assert.equal(node.style.userSelect, "");
  const click = fire("click");
  assert.equal(click.stopped, true, "swallowed, so what was under the pointer is not opened");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fire("click").stopped, false, "and only that one click");
});

test("a press that hardly moves is a click: nothing is moved and nothing is swallowed", async () => {
  const { node, fire } = fake();
  attachDragScroll(node);
  fire("pointerdown", mouse(300, 10));
  fire("pointermove", mouse(300 - (DRAG_THRESHOLD - 2), 10));
  fire("pointerup", mouse(300, 10));
  assert.equal(node.scrollLeft, 0);
  assert.equal(fire("click").stopped, false);
  assert.deepEqual(node.captured, []);
});

test("it pulls up and down too when the picture is taller than its window", async () => {
  const { node, fire } = fake({ scrollWidth: 2000, clientWidth: 600, scrollHeight: 800, clientHeight: 300 });
  attachDragScroll(node);
  fire("pointerdown", mouse(300, 300));
  fire("pointermove", mouse(250, 200));
  assert.deepEqual([node.scrollLeft, node.scrollTop], [50, 100]);
});

test("only the left button of a mouse pulls: a finger scrolls by itself, the right button is the system's, and a picture that fits has nothing to pull", async () => {
  const { node, fire } = fake();
  attachDragScroll(node);
  for (const press of [mouse(300, 0, { button: 2 }), mouse(300, 0, { pointerType: "touch" }), mouse(300, 0, { pointerType: "pen" })]) {
    fire("pointerdown", press);
    fire("pointermove", mouse(100));
    fire("pointerup", mouse(100));
    assert.equal(node.scrollLeft, 0);
  }
  const fits = fake({ scrollWidth: 500, clientWidth: 600, scrollHeight: 300, clientHeight: 300 });
  attachDragScroll(fits.node);
  assert.equal(fits.node.style.cursor, "", "no hand when there is nothing to take");
  fits.fire("pointerdown", mouse(300));
  fits.fire("pointermove", mouse(100));
  assert.equal(fits.node.scrollLeft, 0);
});

test("the wheel turning up and down moves it sideways; Shift, a sideways turn and the ends are left to the browser and the page", async () => {
  const { node, fire } = fake();
  attachDragScroll(node);
  const turned = fire("wheel", { deltaX: 0, deltaY: 120 });
  assert.equal(node.scrollLeft, 120);
  assert.equal(turned.prevented, true);
  assert.equal(fire("wheel", { deltaX: 0, deltaY: 120, shiftKey: true }).prevented, false, "Shift already means sideways");
  assert.equal(fire("wheel", { deltaX: 80, deltaY: 10 }).prevented, false, "a trackpad's sideways swipe");
  assert.equal(fire("wheel", { deltaX: 0, deltaY: 120, ctrlKey: true }).prevented, false, "a pinch");
  node.scrollLeft = 1400; // the end
  assert.equal(fire("wheel", { deltaX: 0, deltaY: 120 }).prevented, false, "at the end the page behind goes on scrolling");
  assert.equal(node.scrollLeft, 1400);
  assert.equal(wheelToSideways({ scrollLeft: 5, scrollWidth: 2000, clientWidth: 600, scrollHeight: 300, clientHeight: 300 }, { deltaX: 0, deltaY: -120 }), 0, "back, but not past the start");
  assert.equal(wheelToSideways({ scrollLeft: 0, scrollWidth: 2000, clientWidth: 600, scrollHeight: 900, clientHeight: 300 }, { deltaX: 0, deltaY: 120 }), null, "something taller than its window scrolls up and down");
});

test("what was attached is taken off again", async () => {
  const { node, fire, count } = fake();
  const off = attachDragScroll(node);
  off();
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerenter", "wheel"]) assert.equal(count(type), 0, type);
  fire("pointerdown", mouse(300));
  fire("pointermove", mouse(100));
  assert.equal(node.scrollLeft, 0);
  assert.equal(node.style.cursor, "");
});
