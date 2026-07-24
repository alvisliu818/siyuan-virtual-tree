import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import postcss from "rollup-plugin-postcss";
import copy from "rollup-plugin-copy";

export default {
  input: "src/index.ts",
  output: {
    dir: ".src",
    format: "commonjs",
    entryFileNames: "index.js",
    assetFileNames: "index.[ext]",
    sourcemap: false,
    exports: "default",
    externalLiveBindings: false,
  },
  plugins: [
    resolve(),
    commonjs(),
    typescript({
      tsconfig: "./tsconfig.json",
    }),
    postcss({
      extract: true,
      minimize: true,
      output: "index.css",
    }),
    copy({
      targets: [
        { src: "plugin.json", dest: ".src" },
        { src: "i18n", dest: ".src" },
        { src: "README.md", dest: ".src" },
        { src: "README_zh_CN.md", dest: ".src" },
        { src: "icon.png", dest: ".src" },
        { src: "preview.png", dest: ".src" },
      ],
    }),
  ],
  external: ["siyuan"],
};
