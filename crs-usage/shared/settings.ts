import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export const managementOriginSchema = z.string().refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}, "CRS 管理地址必须为 HTTPS origin，不含路径、凭据或查询参数");
export const settingsDefinition = defineSettings({
  id: "crs",
  scope: "host",
  version: 1,
  schema: z.object({
    allowedOrigins: z.array(z.string().url()).default([]),
    providerNames: z.array(z.string().min(1)).default([]),
    managementOrigin: managementOriginSchema.default(""),
    // Directory reference only; credentials never belong in settings.
    piConfigDir: z.string().default(""),
    spaPrefix: z
      .string()
      .regex(/^(?:|\/[a-zA-Z0-9_/-]*)$/)
      .default(""),
  }),
});
export type Settings = z.output<typeof settingsDefinition.schema>;
