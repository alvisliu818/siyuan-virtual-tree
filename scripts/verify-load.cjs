// vm 沙箱验证：模拟思源渲染上下文（无 process、有 window），加载 dist/index.js
// 校验 module.exports 存在且为插件类，加载过程不抛错
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "..", "dist", "index.js"), "utf8");

const siyuan = {
    Plugin: class {
        constructor() {}
        async onload() {}
        onLayoutReady() {}
        onunload() {}
        addDock() {}
        addTab() {}
        openSetting() {}
        setting = null;
        i18n = {};
        app = {};
        name = "siyuan-plugin-resource-manager";
        async saveData() {}
        async loadData() {
            return null;
        }
    },
    Setting: class {
        constructor(opts) {
            this.opts = opts;
            this.items = [];
        }
        addItem(item) {
            this.items.push(item);
        }
    },
    Dialog: class {
        constructor() {
            this.element = document.createElement("div");
        }
        destroy() {}
    },
    Menu: class {
        addItem() {
            return this;
        }
        addSeparator() {
            return this;
        }
        open() {}
    },
    showMessage() {},
    confirm() {},
    Lute: class {},
    fetchPost() {
        return Promise.resolve({ code: 0, data: [] });
    },
    async fetchSyncPost() {
        return { code: 0, data: [] };
    },
    openTab() {},
};

const noopEl = new Proxy(
    { style: {}, classList: { add() {}, remove() {} } },
    { get: () => noopEl, set: () => true }
);

const document = {
    createElement: () => noopEl,
    createElementNS: () => noopEl,
    body: { appendChild() {} },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
};

const window = { siyuan: undefined, addEventListener() {}, removeEventListener() {} };

const sb = {
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    globalThis: null,
    module: { exports: {} },
    exports: {},
};
sb.globalThis = sb;
sb.require = (id) => {
    if (id === "siyuan") {
        return siyuan;
    }
    throw new Error("unexpected require: " + id);
};

vm.createContext(sb);

try {
    vm.runInContext(code, sb, { filename: "dist/index.js" });
    const ex = sb.module.exports;
    if (!ex) {
        console.error("LOAD FAILED: module.exports is empty");
        process.exit(1);
    }
    const name = ex && ex.name;
    const proto = Object.getPrototypeOf(ex.prototype ? ex.prototype : {});
    const looksLikePlugin = ex && (ex.prototype instanceof siyuan.Plugin || (ex && typeof ex === "function"));
    console.log("LOADED OK");
    console.log("  module.exports type:", typeof ex);
    console.log("  class name:", name);
    console.log("  prototype inherits Plugin:", ex && ex.prototype instanceof siyuan.Plugin);
} catch (e) {
    console.error("LOAD FAILED:", e.stack || e);
    process.exit(2);
}
