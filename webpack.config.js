const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const {EsbuildPlugin} = require("esbuild-loader");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const MonacoWebpackPlugin = require("monaco-editor-webpack-plugin");

// Monaco 按需加载的语言与特性,控制打包体积
// 注册进 monaco 的语言列表。**必须与 src/editor/monaco.ts 的 LANG_MAP 对齐** ——
// LANG_MAP 里写了但这里没注册的语言,monaco 找不到语言包会静默按 plaintext 处理
// (表现就是 .cs/.php/.rb 全是纯黑白文本,连注释颜色都没有,且没有任何报错)。
// 两个列表都缺的才是真·不支持(会走 LANG_MAP 的默认值 plaintext)。
const monacoLanguages = [
    "typescript", "javascript", "json", "css", "scss", "less", "html", "markdown",
    "xml", "python", "go", "rust", "sql", "yaml", "shell", "java", "c", "cpp",
    "csharp", "php", "ruby",
];
const monacoFeatures = [
    "coreCommands", "find", "format", "hover", "multiCursor", "suggest",
    "bracketMatching", "comment", "clipboard", "codeAction", "folding",
    "codelens", "colorPicker", "documentSymbols", "quickCommand",
];

// 插件身份从 plugin.json 读,不要在各处硬编码。
// 改名(如 siyuan-file-editor → siyuan-virtual-tree)时如果漏改这里,
// 后果是 Monaco 的语言 chunk 请求打到旧名字的目录上 → 404 →
// 语言 Monarch 注册不上 → 所有代码一个颜色(mtk1),且不报错,极难排查。
const PLUGIN_NAME = JSON.parse(fs.readFileSync(path.resolve(__dirname, "plugin.json"), "utf8")).name;

// 思源插件目录(开发模式直接输出到此目录,避免手动复制 chunk 文件)
// 可通过环境变量 SYFI_PLUGIN_DIR 覆盖;默认路径也跟着 PLUGIN_NAME 走
const SIYUAN_PLUGIN_DIR = process.env.SYFI_PLUGIN_DIR
    || `E:\\HOME\\SiYuan\\data\\plugins\\${PLUGIN_NAME}`;

// node-pty 依赖目录。node-pty 是原生模块(内含平台相关的 .node/.dll),
// 无法被 webpack 打包,只能原样复制到插件目录,由运行时 require 加载。
// 装在 scripts/ 下(与 terminal-server 共用依赖),打包时按当前平台只复制一份。
// 注意:scripts/ 是独立 npm 子项目(有自己的 node_modules),不走根的 PnP。
const NODE_PTY_SRC = path.resolve(__dirname, "scripts", "node_modules", "node-pty");
const NODE_PTY_DEST = "node_modules/node-pty";

/**
 * 定位一个依赖包在磁盘上的目录。
 *
 * 2026-10 迁移 Yarn 4 PnP 后,包默认装在全局 cache 的 zip 里,而下面这些包
 * (basedpyright/vditor/vscode-oniguruma/cmake-ts/zeromq)的内容要**整目录复制**
 * 进产物,zip 里的文件无法被 CopyPlugin 拷贝。因此约定:
 *   - 复制源包必须 `yarn unplug <pkg>` 解压到 .yarn/unplugged/(带构建脚本的包
 *     如 zeromq/esbuild 会自动 unplug;纯内容包要手动,cmake-ts 已加进 devDeps
 *     以便 unplug 匹配);
 *   - 这里按「npm 布局 → PnP 解析(unplug 后返回磁盘真实路径)→ 扫 unplug 目录」
 *     三级定位,任一命中即返回,都失败返回 null(调用方决定降级或报错)。
 */
function resolvePkgDir(name) {
    const direct = path.resolve(__dirname, "node_modules", name);
    if (fs.existsSync(direct)) return direct; // npm 布局(向后兼容)
    const pnpCjs = path.resolve(__dirname, ".pnp.cjs");
    if (!fs.existsSync(pnpCjs)) return null;
    try {
        const pnpApi = require(pnpCjs);
        const resolved = pnpApi.resolveRequest(`${name}/package.json`, __filename);
        if (resolved && fs.existsSync(resolved)) return path.dirname(resolved);
    } catch {
        // 解析失败(包不在依赖树)→ 走兜底
    }
    // 兜底:扫 unplug 目录(命名形如 <pkg>-npm-<ver>-<hash>,scoped 包把 / 换 -)
    const unpluggedRoot = path.resolve(__dirname, ".yarn", "unplugged");
    if (fs.existsSync(unpluggedRoot)) {
        const prefix = `${name.replace(/^@/, "").replace(/\//g, "-")}-npm-`;
        for (const dir of fs.readdirSync(unpluggedRoot)) {
            if (!dir.startsWith(prefix)) continue;
            const candidate = path.join(unpluggedRoot, dir, "node_modules", name);
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return null;
}

// basedpyright(pyright 的开源 fork,MIT)语言服务器依赖目录。它是**运行时**用
// ELECTRON_RUN_AS_NODE 拉起的独立 Node 进程,不能被 webpack 打包(webpack 会把
// 它的 require 图当浏览器代码处理,连 fs 都用不了),必须原样复制。
// 选用 basedpyright 而非原版 pyright:原版没有 semanticTokensProvider 能力
// (VS Code 的语义高亮在闭源的 Pylance 里),basedpyright 在 initialize 结果里
// 静态声明该能力,是语义着色(参数名/函数调用等)的数据源。
// 注意:运行时入口路径仍是 <插件目录>/pyright/langserver.index.js —— 目标目录名
// 保持 "pyright" 不变,python-lsp.ts 的定位逻辑与已部署的目录结构都不用动。
// PnP:必须 `yarn unplug basedpyright`(整包 ~35M,zip 里拷不了,见 resolvePkgDir)。
const PYRIGHT_DEST = "pyright";

// zeromq(Task D / Jupyter 后端)。同为原生模块(.node 二进制 + 平台相关 build 目录),
// 无法被 webpack 打包。它的 JS 层(lib/)只做相对引用,原生层在 build/<plat>/<arch>/<abi>,
// 所以复制 lib + package.json + 整个 build 即可(排除各自的调试符号)。
// PnP:带构建脚本,install 时自动 unplug 到磁盘,resolvePkgDir 直接可定位。
const ZEROMQ_DEST = "node_modules/zeromq";

/** 严格版:复制源缺失时直接抛错(vditor/oniguruma 是硬运行时依赖,缺了必须构建失败) */
function requirePkgDir(name) {
    const dir = resolvePkgDir(name);
    if (!dir) {
        throw new Error(`依赖 ${name} 未定位到磁盘目录 —— 确认已安装,且 PnP 下已 \`yarn unplug ${name}\``);
    }
    return dir;
}
// vditor 的 dist 与 oniguruma 的 wasm 在生产/开发两个分支都要复制,启动时定位一次
const VDITOR_DIST = path.join(requirePkgDir("vditor"), "dist");
const ONIG_WASM = path.join(requirePkgDir("vscode-oniguruma"), "release", "onig.wasm");

/**
 * 生成 pyright 的复制规则。
 *
 * 整包原样复制(约 35M),不做任何排除 —— 用户明确要求「不需要管体积, 能用都用上」。
 * 保留全部内容的理由(每项都会实际影响功能):
 *   dist/typeshed-fallback/stdlib  ~5M   Python 标准库存根,缺了满屏红波浪线
 *   dist/typeshed-fallback/stubs   ~20M  第三方库存根,缺了 import 全部报
 *                                        "Import could not be resolved"
 *   dist/*.map                     ~8M   调试符号,排查 basedpyright 自身崩溃时有用
 * 相比这些,体积不构成取舍理由。
 */
function pyrightPatterns() {
    const src = resolvePkgDir("basedpyright");
    if (!src) {
        console.warn("[webpack] 找不到 basedpyright(npm node_modules 或 yarn unplug 均未命中),跳过 pyright 复制 —— Python LSP 将不可用");
        return [];
    }
    return [{from: src, to: PYRIGHT_DEST}];
}

/**
 * 生成 node-pty 的复制规则。
 * node-pty 加载原生模块时按序找 build/Release → build/Debug → prebuilds/<platform>-<arch>,
 * 且是**运行时**按 process.platform/process.arch 解析,
 * 因此这里只需打包构建机当前平台的那一份,避免把 win32/darwin 全带(全量 64M)。
 * 排除 *.pdb(调试符号,占 17M)和测试文件、.map。
 */
function nodePtyPatterns() {
    if (!fs.existsSync(NODE_PTY_SRC)) return [];
    const plat = `${process.platform}-${process.arch}`;
    const prebuildDir = path.join(NODE_PTY_SRC, "prebuilds", plat);
    const patterns = [
        // JS 层(入口 lib/index.js → lib/utils.js 按上述顺序找 .node)
        {from: path.join(NODE_PTY_SRC, "package.json"), to: `${NODE_PTY_DEST}/`},
        {from: path.join(NODE_PTY_SRC, "lib"), to: `${NODE_PTY_DEST}/lib`, globOptions: {ignore: ["**/*.test.js", "**/*.test.js.map", "**/*.map"]}},
        {from: path.join(NODE_PTY_SRC, "typings"), to: `${NODE_PTY_DEST}/typings`},
    ];
    if (fs.existsSync(prebuildDir)) {
        patterns.push({
            from: prebuildDir,
            to: `${NODE_PTY_DEST}/prebuilds/${plat}`,
            // pdb 是调试符号,运行时不需要
            globOptions: {ignore: ["**/*.pdb"]},
        });
    }
    return patterns;
}

/**
 * 生成 zeromq 的复制规则(Jupyter 后端用)。
 * zeromq.js v6 的 JS 层在 lib/,原生层在 build/<platform>/<arch>/<abi|msvc 变体>/addon.node,
 * 运行时由 zeromq 自己按 ABI 探测选择,因此 build 整目录复制(总共约 3M,不再细分)。
 * 排除 .pdb。宿主仓库没装 zeromq 时返回空(不影响构建)。
 */
function zeromqPatterns() {
    const src = resolvePkgDir("zeromq");
    if (!src) return [];
    // cmake-ts 是 zeromq 的 dependencies(lib/load-addon.js 运行时 require
    // "cmake-ts/build/loader" 来定位预编译 .node,缺了整个 zeromq 加载失败 →
    // 所有 Jupyter/conda 内核起不来(实测踩过))。PnP 下它不再是 zeromq 的
    // 物理邻居,必须独立解析;它无构建脚本,已加进 devDeps 以便 yarn unplug。
    const cmakeSrc = resolvePkgDir("cmake-ts");
    if (!cmakeSrc) {
        console.warn("[webpack] 找不到 cmake-ts(zeromq 运行时依赖),跳过 zeromq 复制 —— Jupyter 内核将不可用");
        return [];
    }
    return [
        {from: path.join(src, "package.json"), to: `${ZEROMQ_DEST}/`},
        {from: path.join(src, "lib"), to: `${ZEROMQ_DEST}/lib`, globOptions: {ignore: ["**/*.map"]}},
        {from: path.join(src, "build"), to: `${ZEROMQ_DEST}/build`, globOptions: {ignore: ["**/*.pdb"]}},
        // loader 只依赖 Node 内置模块,复制包本体(package.json + build)即可
        {from: path.join(cmakeSrc, "package.json"), to: "node_modules/cmake-ts/"},
        {from: path.join(cmakeSrc, "build"), to: "node_modules/cmake-ts/build", globOptions: {ignore: ["**/*.map"]}},
    ];
}

module.exports = (env, argv) => {
    const production = argv.mode === "production";
    // 生产模式输出到 dist/ 子目录(完整插件目录)
    // 开发模式输出到思源插件目录(直接生效,避免手动复制大量 chunk 文件)
    const outputPath = production ? path.resolve(__dirname, "dist") : path.resolve(SIYUAN_PLUGIN_DIR);

    const plugins = [
        new MiniCssExtractPlugin({
            filename: "index.css",
        }),
        // 把插件名注入前端代码。凡是"资源路径里有插件名"的地方(如 vditor 的
        // 静态资源目录)都必须用它派生,不能写死 —— 写死后插件一改名就 404,
        // 而且这类失败通常是静默的(资源加载不到,功能半残但不报错)。
        new webpack.DefinePlugin({
            __SYFE_PLUGIN_NAME__: JSON.stringify(PLUGIN_NAME),
        }),
        new MonacoWebpackPlugin({
            languages: monacoLanguages,
            features: monacoFeatures,
        }),
    ];

    if (production) {
        // 生产模式:复制插件清单、图标、文档、i18n 到 dist/
        plugins.push(
            new webpack.BannerPlugin({
                banner: () => {
                    return fs.readFileSync("LICENSE").toString();
                },
            }),
        );
        plugins.push(
            new CopyPlugin({
                patterns: [
                    {from: "preview.png", to: "./", noErrorOnMissing: true},
                    {from: "icon.png", to: "./"},
                    {from: "README*.md", to: "./"},
                    {from: "plugin.json", to: "./"},
                    {from: "src/i18n/", to: "./i18n/"},
                    // Vditor(Markdown 所见即所得)的静态资源:运行时按 cdn 路径懒加载
                    {from: VDITOR_DIST, to: "./vditor/dist"},
                    // pty-helper:真 PTY 的承载进程(ELECTRON_RUN_AS_NODE 拉起,内部用 node-pty)
                    {from: "tools/pty-helper.js", to: "./pty-helper.js"},
                    // syfe-kernel:Python 内核本体(由 pty-helper 以 raw 子进程拉起)
                    {from: "tools/syfe-kernel.py", to: "./syfe-kernel.py"},
                    // jupyter-launch:Windows 中断用启动器(Jupyter 后端)
                    {from: "tools/jupyter-launch.py", to: "./jupyter-launch.py", noErrorOnMissing: true},
                    // node-pty:终端真 PTY 的原生模块(按当前平台复制)
                    ...nodePtyPatterns(),
                    // zeromq:Jupyter 后端的 zmq 通道(按当前平台复制)
                    ...zeromqPatterns(),
                    // pyright:Python 语言服务器(运行时独立进程,需整包复制)
                    ...pyrightPatterns(),
                    // 内置 TextMate 语法(python/js/ts 等官方语法,入库 src/grammars/)
                    // + oniguruma WASM:运行时 fetch /plugins/<name>/grammars/ 加载,
                    // 着色不依赖 CDN(离线可用、加载确定性)
                    {from: "src/grammars/", to: "./grammars/"},
                    {from: ONIG_WASM, to: "./grammars/onig.wasm"},
                ],
            }),
        );
    } else {
        // 开发模式:复制 i18n、plugin.json、icon.png 到思源插件目录
        plugins.push(
            new CopyPlugin({
                patterns: [
                    {from: "src/i18n/", to: "./i18n/"},
                    {from: "plugin.json", to: "./"},
                    {from: "icon.png", to: "./", noErrorOnMissing: true},
                    {from: VDITOR_DIST, to: "./vditor/dist"},
                    // pty-helper:真 PTY 的承载进程
                    {from: "tools/pty-helper.js", to: "./pty-helper.js"},
                    // syfe-kernel:Python 内核本体
                    {from: "tools/syfe-kernel.py", to: "./syfe-kernel.py"},
                    // jupyter-launch:Windows 中断用启动器(Jupyter 后端)
                    {from: "tools/jupyter-launch.py", to: "./jupyter-launch.py", noErrorOnMissing: true},
                    // node-pty:终端真 PTY 的原生模块(按当前平台复制)
                    ...nodePtyPatterns(),
                    // zeromq:Jupyter 后端的 zmq 通道(按当前平台复制)
                    ...zeromqPatterns(),
                    // pyright:Python 语言服务器(运行时独立进程,需整包复制)
                    ...pyrightPatterns(),
                    // 内置 TextMate 语法 + oniguruma WASM(同生产模式)
                    {from: "src/grammars/", to: "./grammars/"},
                    {from: ONIG_WASM, to: "./grammars/onig.wasm"},
                ],
            }),
        );
    }

    return {
        mode: argv.mode || "development",
        watch: !production,
        devtool: production ? false : "eval-source-map",
        // 持久化缓存:模块图与转换结果序列化到 node_modules/.cache/webpack,
        // 二次构建跳过全部模块重建/转换(实测 17s → 4s 级)。缓存键含配置与
        // 依赖清单(见 buildDependencies),改配置/装依赖自动失效,不会用旧缓存
        // 打出过期产物。PnP 迁移后 node_modules/ 不再由包管理器创建,webpack 会
        // 自行 mkdir 这个缓存目录(.gitignore 已覆盖 node_modules/),不入库。
        cache: {
            type: "filesystem",
            buildDependencies: {
                config: [__filename, path.resolve(__dirname, "package.json")],
            },
        },
        output: {
            filename: "index.js",
            // 异步 chunk(Monaco 语言/worker 分包)带内容哈希:内核对插件资源不发
            // Cache-Control,浏览器按 Last-Modified 做启发式缓存;chunk 文件名若固定,
            // 重建后同名旧缓存的 chunk 会与新 index.js 混搭,Monarch 注册不上且不报错
            // (表现:"代码渲染没了/折叠图标不对")。哈希文件名让每次构建都是全新 URL,
            // 从根上避免陈旧缓存;改名/重部署场景同理受益。
            chunkFilename: production ? "[id].[contenthash].index.js" : "[id].index.js",
            path: outputPath,
            // 生产模式:构建前清空 dist/,确保其中只有本次打包产物
            // (zip 等二次产物不输出到此目录,由 scripts/zip-dist.js 输出到 build/)
            clean: production,
            libraryTarget: "commonjs2",
            library: {
                type: "commonjs2",
            },
            // Monaco 的 worker 与语言 chunk 都按 publicPath 懒加载,必须指向插件资源目录。
            // 用 PLUGIN_NAME 拼而不是写死:写死的话插件一改名,这些 chunk 就全部 404,
            // 表现为"代码打开是纯黑白的,没有任何报错"(Monarch 注册不上,全落 mtk1)。
            publicPath: `/plugins/${PLUGIN_NAME}/`,
        },
        externals: {
            siyuan: "siyuan",
        },
        entry: {
            index: "./src/index.ts",
        },
        // 关闭体积性能提示。webpack 的默认阈值(244 KiB)假设的是"浏览器网络下载、
        // 缓存敏感"的 Web 场景;本插件是思源桌面端本地 require 加载,无网络传输,
        // 警告列出的"大文件"(Monaco worker、vditor 静态资源、4.7MB 入口)都是
        // 桌面插件的正常产物。按建议拆 runtime/initial vendor chunk 会引入固定名
        // 文件,与下方"chunkFilename 带 contenthash 防陈旧缓存"的设计相冲突
        // (思源内核不发 Cache-Control,靠 Last-Modified 启发式缓存,见 output 注释)。
        performance: {
            hints: false,
        },
        optimization: {
            minimize: production,
            minimizer: [
                // exclude:跳过 CopyPlugin 复制的 vditor 静态资源
                // (mathjax mathmaps 的 .js 实为 JSON 内容,esbuild 解析会报语法错误)
                new EsbuildPlugin({
                    exclude: /vditor\//,
                }),
            ],
        },
        resolve: {
            extensions: [".ts", ".tsx", ".scss", ".js", ".json"],
        },
        module: {
            rules: [
                {
                    test: /\.ts(x?)$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [
                        {
                            loader: "esbuild-loader",
                            options: {
                                target: "es6",
                            },
                        },
                    ],
                },
                {
                    test: /\.scss$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [
                        MiniCssExtractPlugin.loader,
                        {
                            loader: "css-loader",
                        },
                        {
                            loader: "sass-loader",
                        },
                    ],
                },
                {
                    // Monaco 的 css 由 css-loader 处理
                    test: /\.css$/,
                    use: [MiniCssExtractPlugin.loader, "css-loader"],
                },
            ],
        },
        plugins,
    };
};
