// The detail drawer's width limits; kept apart from the component so they can be tested in node.

export const DRAWER_DEFAULT = 380;
export const DRAWER_MIN = 320;
export const DRAWER_MAX = 960;
/** Room the flow graph keeps beside the drawer. */
export const GRAPH_MIN = 360;

/** Within [min, max], and never so wide that the graph has less than GRAPH_MIN. */
export function clampDrawerWidth(requested: number, container: number): number {
  const max = Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, container - GRAPH_MIN));
  return Math.round(Math.min(Math.max(DRAWER_MIN, requested), max));
}
