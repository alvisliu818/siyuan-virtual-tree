/**
 * 就地渲染 DOM 集成测试的构建 + 运行入口。
 * jsdom 必须 external（原生依赖不能被打进 bundle）。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
    entryPoints: [fileURLToPath(new URL("./test-inplace.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    // jsdom 必须 external（原生依赖不可打入 bundle）；siyuan 用 stub 内联，
    // 否则 esbuild 留 external require("siyuan") 而 node 解析不到该包的默认导出。
    external: ["jsdom"],
    alias: {
        siyuan: fileURLToPath(new URL("./siyuan-stub.cjs", import.meta.url)),
    },
    outfile: fileURLToPath(new URL("../build/test-inplace.cjs", import.meta.url)),
    logLevel: "warning",
});

await import("../build/test-inplace.cjs");
