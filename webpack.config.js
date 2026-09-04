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
                new EsbuildPlugin(),
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
