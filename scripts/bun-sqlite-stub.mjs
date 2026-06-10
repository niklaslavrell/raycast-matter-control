// Stub for `bun:sqlite`. matter.js 0.17 ships a Bun-runtime SQLite storage
// backend that statically imports `bun:sqlite` from `@matter/nodejs`'s ESM
// bundle. On Node that import fails with ERR_UNSUPPORTED_ESM_URL_SCHEME, even
// though matter.js never actually instantiates the Bun backend at runtime.
//
// esbuild aliases `bun:sqlite` to this stub at build time so the import
// resolves to a real module path. The exports throw if anyone tries to use
// them — which shouldn't happen on Node.
const notImplemented = () => {
  throw new Error("bun:sqlite is not available on Node");
};

export const Database = notImplemented;
export const constants = {};
export default { Database, constants };
