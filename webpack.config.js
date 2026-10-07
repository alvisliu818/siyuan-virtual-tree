const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const {EsbuildPlugin} = require("esbuild-loader");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const MonacoWebpackPlugin = require("monaco-editor-webpack-plugin");

// Monaco 按需加载的语言与特性,控制打包体积
const monacoLanguages = [
    "typescript", "javascript", "json", "css", "html", "markdown",
    "xml", "python", "go", "rust", "sql", "yaml", "shell", "java", "c", "cpp",
];
const monacoFeatures = [
    "coreCommands", "find", "format", "hover", "multiCursor", "suggest",
    "bracketMatching", "comment", "clipboard", "codeAction", "folding",
    "codelens", "colorPicker", "documentSymbols", "quickCommand",
];

// 思源插件目录(开发模式直接输出到此目录,避免手动复制 chunk 文件)
// 可通过环境变量 SYFI_PLUGIN_DIR 覆盖
const SIYUAN_PLUGIN_DIR = process.env.SYFI_PLUGIN_DIR || "E:\\HOME\\SiYuan\\data\\plugins\\siyuan-file-editor";

// node-pty 依赖目录。node-pty 是原生模块(内含平台相关的 .node/.dll),
// 无法被 webpack 打包,只能原样复制到插件目录,由运行时 require 加载。
// 装在 scripts/ 下(与 terminal-server 共用依赖),打包时按当前平台只复制一份。
const NODE_PTY_SRC = path.resolve(__dirname, "scripts", "node_modules", "node-pty");
const NODE_PTY_DEST = "node_modules/node-pty";

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

module.exports = (env, argv) => {
    const production = argv.mode === "production";
    // 生产模式输出到 dist/ 子目录(完整插件目录)
    // 开发模式输出到思源插件目录(直接生效,避免手动复制大量 chunk 文件)
    const outputPath = production ? path.resolve(__dirname, "dist") : path.resolve(SIYUAN_PLUGIN_DIR);

    const plugins = [
        new MiniCssExtractPlugin({
            filename: "index.css",
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
                    {from: "node_modules/vditor/dist", to: "./vditor/dist"},
                    // node-pty:终端真 PTY 的原生模块(按当前平台复制)
                    ...nodePtyPatterns(),
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
                    {from: "node_modules/vditor/dist", to: "./vditor/dist"},
                    // node-pty:终端真 PTY 的原生模块(按当前平台复制)
                    ...nodePtyPatterns(),
                ],
            }),
        );
    }

    return {
        mode: argv.mode || "development",
        watch: !production,
        devtool: production ? false : "eval-source-map",
        output: {
            filename: "index.js",
            path: outputPath,
            // 生产模式:构建前清空 dist/,确保其中只有本次打包产物
            // (zip 等二次产物不输出到此目录,由 scripts/zip-dist.js 输出到 build/)
            clean: production,
            libraryTarget: "commonjs2",
            library: {
                type: "commonjs2",
            },
            // Monaco worker 通过 publicPath 加载,必须指向插件资源目录
            publicPath: production ? "/plugins/siyuan-file-editor/" : "/plugins/siyuan-file-editor/",
        },
        externals: {
            siyuan: "siyuan",
        },
        entry: {
            index: "./src/index.ts",
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
