// Feishu rate-limits edits to one message (230020). A card that follows a run is redrawn on
// every tool call and every burst of answer text, so edits are coalesced here: one patch in
// flight per card, at least `intervalMs` between patches, and the latest state wins. The card
// is rendered when its patch goes out, so a clock on it is never older than the patch.
const RATE_LIMITED = /\b230020\b/;
const FINAL_RETRY_MS = 1_000;
const FINAL_ATTEMPTS = 4;

export interface Painter {
  /** Redraws the card from `render` soon; draws in between are dropped. */
  draw(render: () => object): void;
  /**
   * The card's last state. Sent as soon as the previous patch is done; later draws are ignored.
   * If Feishu refuses it for anything but the rate limit, `fallback` is sent instead, so the
   * card does not stay on its running state for good.
   */
  finish(card: object, fallback?: object): void;
  /** How long since the last patch went out, or Infinity before the first. */
  idleFor(): number;
  /** The last patch failed and nothing newer is on its way: the card shows an old state. */
  behind(): boolean;
  /** Stops timers; a patch already on its way still lands. */
  stop(): void;
}

export function createPainter(options: {
  cardId: string;
  patch: (cardId: string, card: object) => Promise<void>;
  log: (line: string) => void;
  intervalMs: number;
  now: () => number;
}): Painter {
  const { cardId, patch, log, intervalMs, now } = options;
  let pending: (() => object) | null = null;
  let fallback: object | null = null;
  let final = false;
  let sending = false;
  let failed = false;
  let lastAt = -Infinity;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

  /** Whether the card now shows `card`. */
  const send = async (card: object, isFinal: boolean): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await patch(cardId, card);
        return true;
      } catch (error) {
        const message = describe(error);
        // A dropped frame is caught up by the next one; the last one has no next.
        if (isFinal && RATE_LIMITED.test(message) && attempt < FINAL_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, FINAL_RETRY_MS * attempt));
          if (!stopped) continue;
        }
        log(`card ${cardId}: ${message}`);
        return false;
      }
    }
  };

  const pump = () => {
    if (sending || pending === null || stopped) return;
    const wait = final ? 0 : lastAt + intervalMs - now();
    if (wait > 0) {
      timer ??= setTimeout(() => {
        timer = null;
        pump();
      }, wait).unref();
      return;
    }
    const render = pending;
    const isFinal = final;
    pending = null;
    sending = true;
    lastAt = now();
    let card: object;
    try {
      card = render();
    } catch (error) {
      sending = false;
      failed = true;
      log(`card ${cardId}: could not render: ${describe(error)}`);
      return;
    }
    void (async () => {
      let shown = await send(card, isFinal);
      if (!shown && isFinal && fallback && !stopped) {
        shown = await send(fallback, true);
      }
      failed = !shown;
    })().finally(() => {
      sending = false;
      pump();
    });
  };

  return {
    draw(render) {
      if (final) return;
      pending = render;
      pump();
    },
    finish(card, fallbackCard) {
      final = true;
      pending = () => card;
      fallback = fallbackCard ?? null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pump();
    },
    idleFor: () => now() - lastAt,
    behind: () => failed && !sending && pending === null && !final,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
