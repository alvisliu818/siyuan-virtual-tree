// 用思源的 Electron 二进制当纯 Node 运行时(ELECTRON_RUN_AS_NODE=1),
// 验证 zeromq 的 prebuild 能否在思源这套 Electron 里加载并真正收发 ——
// 这是 Task D「Node 侧连 zmq」的生死判据。
//
// 用法: ELECTRON_RUN_AS_NODE=1 SiYuan.exe tools/zmq-probe.js
const path = require("path");

const out = {steps: []};
const step = (name, ok, detail) => out.steps.push({name, ok, detail});

const pluginDir = "E:\\HOME\\Local\\siyuan-test-ws\\data\\plugins\\siyuan-file-editor";

(async () => {
    step("node 版本", true, `${process.version} modules=${process.versions.modules}`);

    let zmq;
    try {
        zmq = require(path.join(pluginDir, "node_modules", "zeromq"));
        step("require zeromq", true, `v${zmq.version}`);
        step("Dealer/Router 存在", typeof zmq.Dealer === "function" && typeof zmq.Router === "function");
    } catch (e) {
        step("require zeromq", false, String((e && e.message) || e));
        console.log(JSON.stringify(out, null, 2));
        process.exit(1);
    }

    // 真正收发:ROUTER(bind) ← → DEALER(connect)。
    // 这正是 Jupyter 的 shell 通道组合,而不是随便拿 PUSH/PULL 直连 ——
    // PUSH/PULL 两端互不兼容,那样测不出真实可用性。
    const base = 40000 + (process.pid % 10000);
    try {
        const router = new zmq.Router();
        router.bind(`tcp://127.0.0.1:${base}`);
        await new Promise((r) => setTimeout(r, 200));

        const dealer = new zmq.Dealer();
        dealer.connect(`tcp://127.0.0.1:${base}`);
        // DEALER 连上后要等握手完成才能发,否则首帧会被丢
        await new Promise((r) => setTimeout(r, 400));
        dealer.send(["<IDS|MSG>", "kernel-abc123", "", "", "", "<IDS|MSG>", "", "", "", "hello-from-jupyter"]);

        const frames = await Promise.race([
            router.receive(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("3s 超时没收到")), 3000)),
        ]);
        // ROUTER 收到的第一帧是身份(空串),后面才是消息各分段
        const text = frames.slice(1).map((f) => f.toString()).join("|");
        step("zmq 实际收发(ROUTER/DEALER)", true, text);
        dealer.close();
        router.close();
    } catch (e) {
        step("zmq 实际收发(ROUTER/DEALER)", false, String((e && e.message) || e));
    }

    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
})();