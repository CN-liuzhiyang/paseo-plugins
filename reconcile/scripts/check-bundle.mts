// Builds this plugin with Paseo's own plugin compiler, the one `paseo plugin install` and
// `reload` run, without installing anything: catches what tsc and the tests cannot, such as a
// client module reaching into server/ (even type-only) or a shared module importing node:fs.
//
//   npm run check:bundle -- <Paseo source checkout>     (or set PASEO_SOURCE)
//
// The compiler is read from the checkout's packages/server/src/server/plugins/compiler.ts, so
// the checkout should be the version the daemon runs.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = process.argv[2] || process.env.PASEO_SOURCE;
if (!source) {
  console.error("usage: npm run check:bundle -- <Paseo source checkout>   (or set PASEO_SOURCE)");
  process.exit(2);
}
const compilerPath = path.join(source, "packages", "server", "src", "server", "plugins", "compiler.ts");
if (!existsSync(compilerPath)) {
  console.error(`not a Paseo source checkout (no ${compilerPath})`);
  process.exit(2);
}
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { compilePlugin } = (await import(pathToFileURL(compilerPath).href)) as {
  compilePlugin(entries: { client: string | null; server: string | null }): Promise<{ clientBundle: string | null; serverBundle: string | null }>;
};
try {
  const { clientBundle, serverBundle } = await compilePlugin({
    client: path.join(pluginDir, "index.client.tsx"),
    server: path.join(pluginDir, "index.server.ts"),
  });
  console.log(`ok: client ${clientBundle?.length ?? 0} bytes, server ${serverBundle?.length ?? 0} bytes`);
} catch (error) {
  console.error(`bundle failed: ${(error as Error).message}`);
  process.exit(1);
}
