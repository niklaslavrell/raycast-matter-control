import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

await build({
  entryPoints: [resolve(root, "scripts/matter-cli.ts")],
  outfile: resolve(root, "assets/matter-cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: false,
  keepNames: true,
  // matter.js 0.17's @matter/nodejs ships a Bun-runtime SQLite storage
  // backend that statically imports `bun:sqlite`. Node can't resolve that
  // scheme, so we alias the import to a local stub. The stub throws if
  // actually invoked — matter.js never selects the Bun backend on Node.
  alias: {
    "bun:sqlite": resolve(root, "scripts/bun-sqlite-stub.mjs"),
  },
  banner: {
    // Allow `require` and `__dirname` from bundled CJS deps in an ESM output.
    js: [
      "import { createRequire as __mc_createRequire } from 'node:module';",
      "import { fileURLToPath as __mc_fileURLToPath } from 'node:url';",
      "import { dirname as __mc_dirname } from 'node:path';",
      "const require = __mc_createRequire(import.meta.url);",
      "const __filename = __mc_fileURLToPath(import.meta.url);",
      "const __dirname = __mc_dirname(__filename);",
    ].join("\n"),
  },
});
