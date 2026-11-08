import type { UsageAccount, UsageReport, UsageScope } from "@getpaseo/plugin/server/usage";
import { inputSchema, type PanelEntry } from "../shared/rpc";
import type { Settings } from "../shared/settings";
import { CrsClient } from "./crs-client";
import { discover, readCredential, type Discovered } from "./discovery";
import { mapUsage } from "./usage";
export class UsageService {
  private locators = new Map<string, Discovered>();
  private successes = new Map<string, Pick<PanelEntry, "snapshot" | "successfulAt">>();
  constructor(
    private settings: () => Promise<Settings>,
    private http = new CrsClient(),
  ) {}
  close() {
    this.http.close();
    this.locators.clear();
    this.successes.clear();
  }
  async discover(scope: UsageScope): Promise<UsageAccount[]> {
    const entries = await discover(await this.settings(), scope);
    for (const entry of entries) this.locators.set(entry.id, entry);
    return entries.map((entry) => ({
      key: entry.id,
      label: "CRS 中转",
      harness: "Pi",
      input: { id: entry.id },
    }));
  }
  async identities() {
    const accounts = await this.discover({ kind: "global" });
    return accounts.map((account) => ({
      id: account.key,
      providers: this.locators.get(account.key)!.providers,
    }));
  }
  private async read(entry: Discovered) {
    const key = await readCredential(entry, await this.settings());
    if (!key)
      return {
        snapshot: null,
        error: "CRS 配置或凭据已变更，请刷新用量列表",
        at: Date.now(),
        retryAt: Date.now(),
      };
    const result = await this.http.read(entry.id, entry.origin, key);
    if (result.snapshot)
      this.successes.set(entry.id, {
        snapshot: result.snapshot,
        successfulAt: new Date(result.at).toISOString(),
      });
    return result;
  }
  async fetch(input: unknown): Promise<UsageReport> {
    const parsed = inputSchema.safeParse(input);
    const entry = parsed.success ? this.locators.get(parsed.data.id) : undefined;
    if (!entry) return { status: "error", error: "CRS 配置未发现，请刷新用量列表" };
    const result = await this.read(entry);
    return result.snapshot
      ? mapUsage(result.snapshot, entry.providers)
      : { status: "error", error: result.error ?? "CRS 数据不可用" };
  }
  async panel(): Promise<PanelEntry[]> {
    const identities = await this.identities();
    const settings = await this.settings();
    return Promise.all(
      identities.map(async (item) => {
        const entry = this.locators.get(item.id)!;
        const result = await this.read(entry);
        const last = this.successes.get(item.id);
        const prefix = settings.spaPrefix.replace(/\/$/, "");
        return {
          ...item,
          snapshot: result.snapshot ?? last?.snapshot ?? null,
          error: result.error,
          successfulAt: last?.successfulAt ?? null,
          retryAt: new Date(result.retryAt).toISOString(),
          links: {
            usage: `${entry.origin}/apiStats/`,
            keys: prefix ? `${entry.origin}${prefix}/api-keys` : null,
            accounts: prefix ? `${entry.origin}${prefix}/accounts` : null,
          },
        };
      }),
    );
  }
}
