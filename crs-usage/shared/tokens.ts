import { z } from "zod";

export const TOKEN_PARTS = ["input", "output", "cacheCreate", "cacheRead"] as const;
export const TOKEN_FIELDS = [...TOKEN_PARTS, "requests"] as const;
const count = z.number().finite().nonnegative().nullable();
const counts = z.object({
  input: count,
  output: count,
  cacheCreate: count,
  cacheRead: count,
  requests: count,
});
export const tokenDaysSchema = z.object({
  timezoneOffset: z.number().finite(),
  days: z
    .array(
      counts.extend({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        cost: count.optional(),
        models: z
          .array(counts.extend({ model: z.string().min(1).max(256) }))
          .max(12)
          .nullable(),
      }),
    )
    .max(30),
});
export type TokenDays = z.infer<typeof tokenDaysSchema>;
export type TokenCounts = z.infer<typeof counts>;
export type TokenRange = 1 | 7 | 30;
const empty = (): TokenCounts => ({
  input: 0,
  output: 0,
  cacheCreate: 0,
  cacheRead: 0,
  requests: 0,
});

function add(total: TokenCounts, next: TokenCounts) {
  for (const field of TOKEN_FIELDS)
    total[field] =
      total[field] === null || next[field] === null ? null : total[field]! + next[field]!;
}
export function tokenTotal(values: TokenCounts) {
  return TOKEN_PARTS.some((field) => values[field] === null)
    ? null
    : TOKEN_PARTS.reduce((sum, field) => sum + values[field]!, 0);
}
export function selectTokenDays(data: TokenDays | null | undefined, range: TokenRange) {
  if (!data?.days.length) return [];
  // Calendar dates already use the CRS timezone. Never reinterpret "today" in the client's timezone.
  const latest = Math.max(...data.days.map((day) => Date.parse(`${day.date}T00:00:00Z`)));
  return data.days.filter(
    (day) => Date.parse(`${day.date}T00:00:00Z`) >= latest - (range - 1) * 86400000,
  );
}
export function summarizeTokens(data: TokenDays | null | undefined, range: TokenRange) {
  const days = selectTokenDays(data, range);
  if (!days.length) return null;
  const present = (value: TokenCounts) => TOKEN_FIELDS.some((field) => value[field] !== null);
  if (!days.some((day) => present(day) || day.models?.some(present))) return null;
  const totals = empty();
  const models = new Map<string, TokenCounts>();
  for (const day of days) {
    add(totals, day);
    for (const model of day.models ?? []) {
      const total = models.get(model.model) ?? empty();
      add(total, model);
      models.set(model.model, total);
    }
  }
  // A failed model read leaves every model's range total unknown, rather than undercounting it.
  if (days.some((day) => day.models === null))
    for (const total of models.values()) for (const field of TOKEN_FIELDS) total[field] = null;
  const denominator =
    totals.input === null || totals.cacheCreate === null || totals.cacheRead === null
      ? null
      : totals.input + totals.cacheCreate + totals.cacheRead;
  return {
    ...totals,
    total: tokenTotal(totals),
    hitRate: denominator ? (totals.cacheRead! / denominator) * 100 : null,
    models: [...models]
      .map(([model, values]) => ({ model, ...values }))
      .sort(
        (a, b) => (tokenTotal(b) ?? -1) - (tokenTotal(a) ?? -1) || a.model.localeCompare(b.model),
      ),
  };
}

export function formatTokens(value: number | null) {
  if (value === null) return "—";
  if (value < 10000) return "<0.01M";
  const millions = value / 1e6;
  if (millions >= 100 || Number(millions.toFixed(1)) >= 100)
    return `${Math.round(millions).toLocaleString("en-US")}M`;
  if (millions >= 10 || Number(millions.toFixed(2)) >= 10) return `${millions.toFixed(1)}M`;
  return `${millions.toFixed(2)}M`;
}
