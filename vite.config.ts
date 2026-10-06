import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// 思源插件入口 index.js 必须能被思源用 require() 加载，因此产物只能是 CJS。
export default defineConfig({
    // 插件渲染上下文没有 Node 的 process，任何访问 process.env.NODE_ENV 的代码
    // 都会在求值期抛 ReferenceError -> 思源报 "plugin not found"。
    define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
    },

    build: {
        emptyOutDir: false,
        sourcemap: false,
        minify: false,
        lib: {
            entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
            formats: ["cjs"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            // 运行时符号（Plugin/Setting/fetchPost...）由思源渲染进程提供
            external: ["siyuan"],
            output: {
                format: "cjs",
                exports: "default",
                // 思源约定自动加载插件目录下的 index.css
                assetFileNames: (info) =>
                    info.name && info.name.endsWith(".css")
                        ? "index.css"
                        : "assets/[name][extname]",
            },
        },
    },
});
