// How far a picture is enlarged while it is looked at full screen: 1 is the whole picture fitted to the screen, more is closer.
// Kept apart from the drawing so the numbers can be tested.

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 6;

export const clampZoom = (scale: number) => (Number.isFinite(scale) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale)) : ZOOM_MIN);

/** The wheel: away from you (deltaY > 0) is farther, toward you is closer; a notch is about a tenth. */
export const zoomByWheel = (scale: number, deltaY: number) => clampZoom(scale * Math.exp(-deltaY / 500));

/** Two fingers: the picture grows as the fingers part, in the same proportion. */
export const zoomByPinch = (scaleAtStart: number, gapAtStart: number, gapNow: number) => (gapAtStart > 0 ? clampZoom(scaleAtStart * (gapNow / gapAtStart)) : scaleAtStart);

/** The distance between two touch points. */
export const gapOf = (a: { pageX: number; pageY: number }, b: { pageX: number; pageY: number }) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
