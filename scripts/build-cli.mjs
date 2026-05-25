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
