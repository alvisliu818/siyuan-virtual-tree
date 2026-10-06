/** 用 esbuild 把 TS 测试打成 CJS 再跑（vite 已带 esbuild，无需额外依赖）。 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
    entryPoints: [fileURLToPath(new URL("./test-sql.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile: fileURLToPath(new URL("../build/test-sql.cjs", import.meta.url)),
    logLevel: "warning",
});

await import("../build/test-sql.cjs");
