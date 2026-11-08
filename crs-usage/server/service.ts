import type { UsageAccount, UsageReport, UsageScope } from "@getpaseo/plugin/server/usage";
import { inputSchema, type PanelEntry } from "../shared/rpc";
import { managementOriginSchema, type Settings } from "../shared/settings";
import { CrsClient } from "./crs-client";
import { discover, originOf, readCredential, type Discovered } from "./discovery";
import { mapUsage, shortUsageError } from "./usage";
export class UsageService {
  private locators = new Map<string, Discovered>();
  private successes = new Map<string, Pick<PanelEntry, "snapshot" | "successfulAt">>();
  constructor(
    private settings: () => Promise<Settings>,
    private http = new CrsClient(),
    private env: NodeJS.ProcessEnv = process.env,
  ) {}
  close() {
    this.http.close();
    this.locators.clear();
    this.successes.clear();
  }
  async discover(scope: UsageScope): Promise<UsageAccount[]> {
    const settings = await this.settings();
    const candidates = await discover(settings, scope, this.env);
    const entries = (
      await Promise.all(
        candidates.map(async (entry) => {
          const key = await readCredential(entry, settings);
          const origin = settings.managementOrigin
            ? originOf(settings.managementOrigin)
            : entry.origin;
          if (
            !key ||
            !origin ||
            !managementOriginSchema.safeParse(settings.managementOrigin).success ||
            !(await this.http.detect(entry.id, origin, key))
          )
            return null;
          this.locators.set(entry.id, entry);
          return entry;
        }),
      )
    ).filter((entry): entry is Discovered => entry !== null);
    return entries.map((entry) => ({
      key: entry.id,

      harness: [
        ...new Set(
          entry.locators.map(
            (locator) => ({ pi: "Pi", claude: "Claude Code", codex: "Codex" })[locator.kind],
          ),
        ),
      ].join(" / "),
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
    const settings = await this.settings();
    const origin = settings.managementOrigin ? originOf(settings.managementOrigin) : entry.origin;
    const configurationError =
      !managementOriginSchema.safeParse(settings.managementOrigin).success || !origin
        ? "请在设置里配置 CRS 管理地址（HTTPS）"
        : null;
    if (configurationError)
      return {
        snapshot: null,
        error: configurationError,
        at: Date.now(),
        retryAt: Date.now(),
        origin: origin ?? entry.origin,
      };
    const key = await readCredential(entry, settings);
    if (!key)
      return {
        snapshot: null,
        error: "CRS 配置或凭据已变更，请刷新用量列表",
        at: Date.now(),
        retryAt: Date.now(),
        origin: origin!,
      };
    const result = await this.http.read(entry.id, origin!, key);
    if (result.snapshot)
      this.successes.set(JSON.stringify([entry.id, result.origin]), {
        snapshot: result.snapshot,
        successfulAt: new Date(result.at).toISOString(),
      });
    return result;
  }
  async fetch(input: unknown): Promise<UsageReport> {
    const parsed = inputSchema.safeParse(input);
    const entry = parsed.success ? this.locators.get(parsed.data.id) : undefined;
    if (!entry) return { status: "error", error: "CRS 配置未发现" };
    const result = await this.read(entry);
    return result.snapshot
      ? mapUsage(result.snapshot)
      : { status: "error", error: shortUsageError(result.error ?? "CRS 数据不可用") };
  }
  async panel(): Promise<PanelEntry[]> {
    const identities = await this.identities();
    const settings = await this.settings();
    return Promise.all(
      identities.map(async (item) => {
        const entry = this.locators.get(item.id)!;
        const result = await this.read(entry);
        const last = this.successes.get(JSON.stringify([item.id, result.origin]));
        const prefix = settings.spaPrefix.replace(/\/$/, "");
        return {
          ...item,
          snapshot: result.snapshot ?? last?.snapshot ?? null,
          error: result.error,
          successfulAt: last?.successfulAt ?? null,
          retryAt: new Date(result.retryAt).toISOString(),
          links: {
            usage: `${result.origin}/apiStats/`,
            keys: prefix ? `${result.origin}${prefix}/api-keys` : null,
            accounts: prefix ? `${result.origin}${prefix}/accounts` : null,
          },
        };
      }),
    );
  }
}
