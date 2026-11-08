import { snapshotSchema, type Snapshot } from "../shared/snapshot";
import { z } from "zod";
export type FetchResult = {
  snapshot: Snapshot | null;
  error: string | null;
  at: number;
  retryAt: number;
};
type State = {
  failures: number;
  next: number;
  result?: FetchResult;
  pending?: Promise<FetchResult>;
};
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty");
  let body = "";
  let size = 0;
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 1024 * 1024) {
      await reader.cancel();
      throw new Error("size");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(body + decoder.decode());
}
function redact(value: unknown, key: string): unknown {
  if (typeof value === "string") return value.split(key).join("[redacted]");
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redact(item, key)]),
    );
  return value;
}
export class CrsClient {
  private states = new Map<string, State>();
  private controllers = new Set<AbortController>();
  constructor(
    private options: {
      fetch?: typeof fetch;
      now?: () => number;
      timeoutMs?: number;
      random?: () => number;
    } = {},
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  close() {
    for (const controller of this.controllers) controller.abort();
    this.states.clear();
  }
  read(id: string, origin: string, key: string): Promise<FetchResult> {
    const state = this.states.get(id) ?? { failures: 0, next: 0 };
    this.states.set(id, state);
    if (state.pending) return state.pending;
    if (state.result && this.now() < state.next) return Promise.resolve(state.result);
    state.pending = this.request(origin, key, state).finally(() => {
      state.pending = undefined;
    });
    return state.pending;
  }
  private async request(origin: string, key: string, state: State): Promise<FetchResult> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 9000);
    let snapshot: Snapshot | null = null;
    let error: string | null = null;
    let retry = 0;
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${origin}/apiStats/api/usage-snapshot`,
        {
          headers: { "x-api-key": key, accept: "application/json" },
          signal: controller.signal,
          redirect: "error",
        },
      );
      const after = response.headers.get("retry-after");
      if (after)
        retry = /^\d+(\.\d+)?$/.test(after)
          ? Number(after) * 1000
          : Math.max(0, Date.parse(after) - this.now());
      if (!response.ok) {
        if (response.status === 403) {
          const value = (await boundedJson(response).catch(() => null)) as {
            key?: { status?: string };
          } | null;
          error =
            value?.key?.status === "expired"
              ? "API Key 已过期，请在 CRS 网页管理"
              : value?.key?.status === "disabled"
                ? "API Key 已禁用，请在 CRS 网页管理"
                : "CRS 拒绝访问，请检查 Key 状态";
        } else
          error =
            response.status === 401
              ? "API Key 无效，请检查本机凭据"
              : response.status === 429
                ? "CRS 请求限流，稍后重试"
                : `CRS 服务请求失败（HTTP ${response.status}）`;
        if (response.status === 401 || response.status === 403) retry = Math.max(retry, 300000);
        await response.body?.cancel().catch(() => {});
      } else {
        // Never forward vendor fields, raw exceptions, or credentials echoed into labels.
        const sanitized = redact(await boundedJson(response), key);
        const status = z.object({ key: z.object({ status: z.string() }) }).safeParse(sanitized);
        const parsed = snapshotSchema.safeParse(sanitized);
        if (status.success && ["expired", "disabled", "inactive"].includes(status.data.key.status))
          error =
            status.data.key.status === "expired"
              ? "API Key 已过期，请在 CRS 网页管理"
              : status.data.key.status === "disabled"
                ? "API Key 已禁用，请在 CRS 网页管理"
                : "API Key 尚未激活";
        else if (!parsed.success) error = "CRS 快照格式不匹配或数据缺失";
        else snapshot = parsed.data;
      }
    } catch {
      error = controller.signal.aborted ? "CRS 请求超时，已中止连接" : "CRS 暂时连不上或响应无效";
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
    const at = this.now();
    state.failures = error ? state.failures + 1 : 0;
    const backoff = error
      ? Math.min(300000, 30000 * 2 ** Math.min(state.failures - 1, 4)) *
        (1 + (this.options.random ?? Math.random)() * 0.1)
      : 12000;
    state.next = at + Math.max(12000, backoff, Number.isFinite(retry) ? retry : 0);
    const result = { snapshot, error, at, retryAt: state.next };
    state.result = result;
    return result;
  }
}
