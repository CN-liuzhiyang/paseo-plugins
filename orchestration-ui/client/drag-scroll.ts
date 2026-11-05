// Dragging a scrolling area with the mouse, for the web and the desktop app: a browser scrolls with the wheel and the bar but not by
// holding the button and pulling, which is what a picture wider than its window asks for. Written against the few things of a DOM
// element it uses, so it can be tried without a browser (server/drag-scroll.test.ts). A phone scrolls by touch by itself and is left alone.

export interface ScrollableNode {
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  style: { cursor: string; userSelect: string };
  addEventListener(type: string, listener: (event: any) => void, options?: boolean | { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: string, listener: (event: any) => void, options?: boolean | { capture?: boolean }): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

/** How far the pointer has to go before a press is a drag and not a click, in pixels. */
export const DRAG_THRESHOLD = 5;

/** What a wheel turn does: the vertical turn moves a picture that is wider than it is tall sideways, until it reaches an end. */
export function wheelToSideways(node: Pick<ScrollableNode, "scrollLeft" | "scrollWidth" | "clientWidth" | "scrollHeight" | "clientHeight">, event: { deltaX: number; deltaY: number; shiftKey?: boolean; ctrlKey?: boolean }): number | null {
  if (event.ctrlKey || event.shiftKey) return null; // a pinch, and Shift's own sideways: as the browser has them
  if (event.deltaY === 0 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return null; // a sideways turn (a trackpad) is already sideways
  const room = node.scrollWidth - node.clientWidth;
  if (room <= 0) return null;
  // Something taller than its window scrolls the way it always did.
  if (node.scrollHeight > node.clientHeight + 1) return null;
  const to = Math.min(room, Math.max(0, node.scrollLeft + event.deltaY));
  // At an end the turn is not taken: the page behind goes on scrolling.
  return to === node.scrollLeft ? null : to;
}

/** Makes `node` draggable with the mouse. Returns what undoes it. */
export function attachDragScroll(node: ScrollableNode): () => void {
  let press: { id: number; x: number; y: number; left: number; top: number; dragging: boolean } | null = null;
  const shown = node.style.userSelect;

  const canMove = () => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight;
  const hover = () => {
    if (!press) node.style.cursor = canMove() ? "grab" : "";
  };
  const lose = () => {
    if (press?.dragging) node.releasePointerCapture?.(press.id);
    press = null;
    node.style.userSelect = shown;
    hover();
  };

  const down = (event: any) => {
    // The left button of a mouse; a finger scrolls by itself and the right button is the system's menu.
    if (event.pointerType !== "mouse" || event.button !== 0 || !canMove()) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop, dragging: false };
    node.style.userSelect = "none";
  };
  const move = (event: any) => {
    if (!press || event.pointerId !== press.id) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!press.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      press.dragging = true;
      node.setPointerCapture?.(press.id);
      node.style.cursor = "grabbing";
    }
    node.scrollLeft = press.left - dx;
    node.scrollTop = press.top - dy;
    event.preventDefault?.();
  };
  const up = (event: any) => {
    if (!press || event.pointerId !== press.id) return;
    const dragged = press.dragging;
    lose();
    if (dragged) {
      // The click that follows the end of a drag is not a click on whatever is under the pointer.
      const swallow = (click: any) => {
        click.stopPropagation();
        click.preventDefault?.();
      };
      node.addEventListener("click", swallow, true);
      setTimeout(() => node.removeEventListener("click", swallow, true), 0);
    }
  };
  const wheel = (event: any) => {
    const to = wheelToSideways(node, event);
    if (to === null) return;
    node.scrollLeft = to;
    event.preventDefault();
  };

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", up);
  node.addEventListener("pointerenter", hover);
  node.addEventListener("wheel", wheel, { passive: false });
  hover();
  return () => {
    node.removeEventListener("pointerdown", down);
    node.removeEventListener("pointermove", move);
    node.removeEventListener("pointerup", up);
    node.removeEventListener("pointercancel", up);
    node.removeEventListener("pointerenter", hover);
    node.removeEventListener("wheel", wheel);
    lose();
    node.style.cursor = "";
  };
}
