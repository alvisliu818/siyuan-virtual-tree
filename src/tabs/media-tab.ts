import {openTab, showMessage} from "siyuan";
import {
    MEDIA_TAB_TYPE,
    MediaKind,
    formatFileSize,
    getMediaKind,
    getMediaMime,
    isMediaFile,
} from "../constants";
import {basename, dirname, extname, joinPath} from "../utils/path";
import {readBinaryFile, readDir} from "../api/file";
import {createBacklinkPanel, BacklinkPanel} from "../components/backlink-panel";
import {copyText} from "../components/file-tree";
import {toFileLink} from "../utils/system-path";
import {openTreeFileWithExternalApp} from "../utils/external-app";

// 音视频播放器 Tab 所需的插件接口(结构化类型,避免循环依赖)
export interface IPluginForMediaTab {
    app: any;
    name: string;
    getOpenedTab(): { [key: string]: any[] };
}

// 播放器 Tab 实例上附加的字段
interface MediaTabInstance {
    element: HTMLElement;
    data: { path?: string };
    parent?: { updateTitle?: (t: string) => void; headElement?: HTMLElement };
    _path?: string;
    _objectUrl?: string; // 当前媒体的 blob URL(destroy / 切换时需释放)
    _disposables?: Array<() => void>;
    _backlink?: BacklinkPanel; // 反向链接面板(同目录切换时更新目标)
}

// 可选倍速(循环切换)
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
// 单次快进/快退秒数
const SEEK_STEP = 5;

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 秒 → 时:分:秒 / 分:秒
function formatDuration(sec: number): string {
    if (!isFinite(sec) || sec < 0) return "00:00";
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// 打开播放器 Tab(同文件去重,聚焦已有 Tab)
// opts.position 指定时,在指定方向以分栏方式打开
export function openMediaTab(plugin: IPluginForMediaTab, path: string, opts?: { position?: "right" | "bottom" }): void {
    const opened = plugin.getOpenedTab()[MEDIA_TAB_TYPE] || [];
    const existing = opened.find((c: any) => c?.data?.path === path);
    if (existing) {
        const tab = (existing as any).parent;
        if (tab?.headElement) {
            (tab.headElement as HTMLElement).click();
        }
        return;
    }
    const kind = getMediaKind(path) as MediaKind;
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + MEDIA_TAB_TYPE,
            icon: kind === "audio" ? "iconRecord" : "iconVideo",
            title: basename(path),
            data: {path},
        },
        position: opts?.position,
    } as any);
}

// 创建播放器 addTab 配置(捕获 plugin 闭包)
export function createMediaTabConfig(plugin: IPluginForMediaTab) {
    return {
        type: MEDIA_TAB_TYPE,
        init(this: MediaTabInstance) {
            const path = this.data?.path;
            if (!path) {
                this.element.innerHTML = `<div class="syfe-empty">未指定媒体文件路径</div>`;
                return;
            }
            this.element.classList.add("syfe-media-tab");
            this._disposables = [];

            const dom = buildPlayerDOM(this.element);

            // 反向链接面板(默认收起,展开时懒扫描)
            this._backlink = createBacklinkPanel(plugin as any, path);
            (this.element.querySelector(".syfe-media__backlink") as HTMLElement).appendChild(this._backlink.el);
            this._disposables.push(() => this._backlink?.dispose());

            const player = createPlayer(dom, plugin, this);
            this._disposables.push(() => player.dispose());
            player.load(path);
        },
        destroy(this: MediaTabInstance) {
            this._disposables?.forEach(d => {
                try {
                    d();
                } catch {
                    // 忽略
                }
            });
            this._disposables = [];
            releaseObjectUrl(this);
        },
    };
}

// 释放当前 blob URL(先停掉播放,避免正在读取已释放的资源)
function releaseObjectUrl(tab: MediaTabInstance): void {
    const media = tab.element.querySelector("video, audio") as HTMLMediaElement | null;
    if (media) {
        try {
            media.pause();
            media.removeAttribute("src");
            media.load();
        } catch {
            // 忽略
        }
    }
    if (tab._objectUrl) {
        try {
            URL.revokeObjectURL(tab._objectUrl);
        } catch {
            // 忽略
        }
        tab._objectUrl = undefined;
    }
}

interface PlayerDOM {
    root: HTMLElement;
    pathLabel: HTMLElement;
    toolbar: HTMLElement;
    rateBtn: HTMLButtonElement;
    loopBtn: HTMLButtonElement;
    pipBtn: HTMLButtonElement;
    fullBtn: HTMLButtonElement;
    infoLabel: HTMLElement;
    viewport: HTMLElement;
    stage: HTMLElement;
    prevBtn: HTMLButtonElement;
    nextBtn: HTMLButtonElement;
}

// 构建播放器 DOM,返回关键节点引用
function buildPlayerDOM(container: HTMLElement): PlayerDOM {
    container.innerHTML = `
        <div class="syfe-media">
            <div class="syfe-media__header">
                <span class="syfe-media__pathtext"></span>
            </div>
            <div class="syfe-media__toolbar">
                <button class="b3-button b3-button--text" data-action="prev" title="上一个 (,)">
                    <svg><use xlink:href="#iconLeft"></use></svg>
                </button>
                <button class="b3-button b3-button--text" data-action="next" title="下一个 (.)">
                    <svg><use xlink:href="#iconRight"></use></svg>
                </button>
                <span class="syfe-media__sep"></span>
                <button class="b3-button b3-button--text syfe-media__rate" data-action="rate" title="播放倍速">1.0x</button>
                <button class="b3-button b3-button--text" data-action="loop" title="循环播放">循环</button>
                <button class="b3-button b3-button--text" data-action="pip" title="画中画 (P)">画中画</button>
                <button class="b3-button b3-button--text" data-action="fullscreen" title="全屏 (F)">全屏</button>
                <span class="syfe-media__sep"></span>
                <button class="b3-button b3-button--text" data-action="copy" title="复制文件链接 (file://)">复制链接</button>
                <button class="b3-button b3-button--text" data-action="save" title="另存为">另存为</button>
                <span class="syfe-media__info"></span>
            </div>
            <div class="syfe-media__backlink"></div>
            <div class="syfe-media__viewport">
                <div class="syfe-media__stage"><div class="syfe-media__hint">加载中...</div></div>
            </div>
        </div>`;

    return {
        root: container.querySelector(".syfe-media") as HTMLElement,
        pathLabel: container.querySelector(".syfe-media__pathtext") as HTMLElement,
        toolbar: container.querySelector(".syfe-media__toolbar") as HTMLElement,
        rateBtn: container.querySelector('[data-action="rate"]') as HTMLButtonElement,
        loopBtn: container.querySelector('[data-action="loop"]') as HTMLButtonElement,
        pipBtn: container.querySelector('[data-action="pip"]') as HTMLButtonElement,
        fullBtn: container.querySelector('[data-action="fullscreen"]') as HTMLButtonElement,
        infoLabel: container.querySelector(".syfe-media__info") as HTMLElement,
        viewport: container.querySelector(".syfe-media__viewport") as HTMLElement,
        stage: container.querySelector(".syfe-media__stage") as HTMLElement,
        prevBtn: container.querySelector('[data-action="prev"]') as HTMLButtonElement,
        nextBtn: container.querySelector('[data-action="next"]') as HTMLButtonElement,
    };
}

interface Player {
    load(path: string): void;
    dispose(): void;
}

// 播放器核心逻辑:加载、倍速、循环、画中画、全屏、同目录切换
function createPlayer(dom: PlayerDOM, plugin: IPluginForMediaTab, tab: MediaTabInstance): Player {
    let path = "";
    let kind: MediaKind = "video";
    let byteLength = 0;
    let rateIndex = PLAYBACK_RATES.indexOf(1);
    // 同目录音视频列表(用于上一个/下一个)
    let siblings: string[] = [];
    let siblingIndex = -1;
    // 加载令牌,避免快速切换时旧请求覆盖新媒体
    let loadToken = 0;

    const currentMedia = () => dom.stage.querySelector("video, audio") as HTMLMediaElement | null;

    function updateInfo(): void {
        const media = currentMedia();
        const parts: string[] = [];
        const duration = media?.duration;
        if (duration && isFinite(duration)) parts.push(formatDuration(duration));
        if (kind === "video" && media && (media as HTMLVideoElement).videoWidth) {
            parts.push(`${(media as HTMLVideoElement).videoWidth}×${(media as HTMLVideoElement).videoHeight}`);
        }
        if (byteLength) parts.push(formatFileSize(byteLength));
        parts.push(extname(path).replace(/^\./, "").toUpperCase());
        if (siblings.length > 1 && siblingIndex >= 0) parts.push(`${siblingIndex + 1}/${siblings.length}`);
        dom.infoLabel.textContent = parts.join(" · ");
    }

    function syncToolbar(): void {
        const media = currentMedia();
        // 音频没有画面,画中画/全屏无意义
        const isVideo = kind === "video";
        dom.pipBtn.style.display = isVideo ? "" : "none";
        dom.fullBtn.style.display = isVideo ? "" : "none";
        dom.pipBtn.disabled = !isVideo || !(document as any).pictureInPictureEnabled;
        if (media) {
            const rate = media.playbackRate || 1;
            dom.rateBtn.textContent = `${rate.toFixed(2).replace(/0$/, "").replace(/\.$/, "")}x`;
            dom.loopBtn.classList.toggle("syfe-media__btn--active", media.loop);
        }
    }

    // ---- 同目录切换 ----
    async function loadSiblings(target: string): Promise<void> {
        siblings = [];
        siblingIndex = -1;
        try {
            const dir = dirname(target);
            const entries = await readDir(dir);
            const list: string[] = [];
            for (const entry of entries) {
                const full = joinPath(dir, entry.name);
                // 视频与音频混在同目录时一起排,便于连续播放
                if (!entry.isDir && isMediaFile(full)) list.push(full);
            }
            list.sort((a, b) => basename(a).localeCompare(basename(b)));
            siblings = list;
            siblingIndex = list.indexOf(target);
        } catch {
            // 目录不可读时禁用切换按钮
        }
        dom.prevBtn.disabled = siblings.length === 0 || siblingIndex <= 0;
        dom.nextBtn.disabled = siblings.length === 0 || siblingIndex < 0 || siblingIndex >= siblings.length - 1;
        updateInfo();
    }

    function goto(index: number): void {
        const target = siblings[index];
        if (!target) return;
        // 若目标已在其他 Tab 打开,聚焦该 Tab
        const opened = plugin.getOpenedTab()[MEDIA_TAB_TYPE] || [];
        const existing = opened.find((c: any) => c?.data?.path === target);
        if (existing) {
            const t = (existing as any).parent;
            if (t?.headElement) {
                (t.headElement as HTMLElement).click();
                return;
            }
        }
        load(target);
    }

    // ---- 加载媒体 ----
    async function load(target: string): Promise<void> {
        const token = ++loadToken;
        path = target;
        kind = getMediaKind(target) || "video";
        tab._path = target;
        tab.data.path = target;
        // 反向链接面板跟随当前文件
        tab._backlink?.setTarget(target);
        try {
            tab.parent?.updateTitle?.(basename(target));
        } catch {
            // 忽略标题更新失败
        }
        dom.pathLabel.textContent = target;
        dom.pathLabel.title = target;
        dom.stage.innerHTML = `<div class="syfe-media__hint">加载中...(大文件可能需要几秒)</div>`;
        byteLength = 0;
        updateInfo();
        void loadSiblings(target);

        // 先释放上一个文件,避免多个大文件同时驻留内存
        releaseObjectUrl(tab);

        let buf: ArrayBuffer;
        try {
            buf = await readBinaryFile(target);
        } catch (e) {
            if (token !== loadToken) return;
            dom.stage.innerHTML = `
                <div class="syfe-media__error">
                    <div>读取失败: ${escapeHTML(String(e))}</div>
                    <button class="b3-button b3-button--outline" data-retry>重试</button>
                </div>`;
            dom.stage.querySelector("[data-retry]")?.addEventListener("click", () => load(target));
            return;
        }
        if (token !== loadToken) return;

        if (tab._objectUrl) {
            try {
                URL.revokeObjectURL(tab._objectUrl);
            } catch {
                // 忽略
            }
        }
        const blob = new Blob([buf], {type: getMediaMime(target)});
        const url = URL.createObjectURL(blob);
        tab._objectUrl = url;
        byteLength = buf.byteLength;

        const media: HTMLMediaElement = document.createElement(kind === "audio" ? "audio" : "video");
        media.className = "syfe-media__el";
        media.controls = true;
        media.preload = "metadata";
        media.playbackRate = PLAYBACK_RATES[rateIndex] ?? 1;
        if (kind === "video") {
            (media as HTMLVideoElement).playsInline = true;
        }
        media.addEventListener("loadedmetadata", () => {
            if (token !== loadToken) return;
            updateInfo();
        });
        media.addEventListener("error", () => {
            if (token !== loadToken) return;
            dom.stage.innerHTML = `
                <div class="syfe-media__error">
                    <div>无法播放该文件,浏览器不支持此编码格式(如 H.265/HEVC 或部分 AVI/FLV)</div>
                    <button class="b3-button b3-button--outline" data-external>用系统默认应用打开</button>
                </div>`;
            dom.stage.querySelector("[data-external]")?.addEventListener("click", () => {
                void openExternal(target);
            });
        });

        media.src = url;
        dom.stage.innerHTML = "";
        if (kind === "audio") {
            const card = document.createElement("div");
            card.className = "syfe-media__audio-card";
            card.innerHTML = `
                <div class="syfe-media__audio-icon"><svg><use xlink:href="#iconRecord"></use></svg></div>
                <div class="syfe-media__audio-name" title="${escapeHTML(basename(target))}">${escapeHTML(basename(target))}</div>`;
            card.appendChild(media);
            dom.stage.appendChild(card);
        } else {
            dom.stage.appendChild(media);
        }
        updateInfo();
        syncToolbar();
    }

    // 用系统默认应用打开(浏览器解码失败时的兜底)
    async function openExternal(target: string): Promise<void> {
        try {
            await openTreeFileWithExternalApp(target);
        } catch (e) {
            showMessage(`打开失败: ${e}`, 3000, "error");
        }
    }

    function cycleRate(): void {
        const media = currentMedia();
        if (!media) return;
        rateIndex = (rateIndex + 1) % PLAYBACK_RATES.length;
        media.playbackRate = PLAYBACK_RATES[rateIndex];
        syncToolbar();
    }

    function toggleLoop(): void {
        const media = currentMedia();
        if (!media) return;
        media.loop = !media.loop;
        syncToolbar();
    }

    function togglePip(): void {
        const media = currentMedia() as HTMLVideoElement | null;
        if (!media || kind !== "video") return;
        const anyDoc = document as any;
        if (document.pictureInPictureElement) {
            void anyDoc.exitPictureInPicture?.();
            return;
        }
        if (!anyDoc.pictureInPictureEnabled || typeof media.requestPictureInPicture !== "function") {
            showMessage("当前环境不支持画中画", 3000, "info");
            return;
        }
        media.requestPictureInPicture().catch(() => showMessage("画中画启动失败", 3000, "error"));
    }

    function toggleFullscreen(): void {
        const media = currentMedia() as HTMLVideoElement | null;
        if (!media) return;
        if (document.fullscreenElement) {
            void document.exitFullscreen?.();
            return;
        }
        const req = (media as any).requestFullscreen || (media as any).webkitRequestFullscreen;
        if (typeof req !== "function") {
            showMessage("当前环境不支持全屏", 3000, "info");
            return;
        }
        req.call(media).catch(() => showMessage("全屏启动失败", 3000, "error"));
    }

    function seek(delta: number): void {
        const media = currentMedia();
        if (!media || !isFinite(media.duration)) return;
        media.currentTime = Math.min(Math.max(media.currentTime + delta, 0), media.duration);
    }

    function changeVolume(delta: number): void {
        const media = currentMedia();
        if (!media) return;
        media.volume = Math.min(Math.max(media.volume + delta, 0), 1);
    }

    function toggleMute(): void {
        const media = currentMedia();
        if (!media) return;
        media.muted = !media.muted;
    }

    function togglePlay(): void {
        const media = currentMedia();
        if (!media) return;
        if (media.paused) {
            media.play().catch(() => showMessage("播放失败", 3000, "error"));
        } else {
            media.pause();
        }
    }

    // 另存为(触发浏览器下载)
    function saveAs(): void {
        if (!tab._objectUrl) {
            showMessage("媒体尚未加载完成", 2000, "info");
            return;
        }
        const a = document.createElement("a");
        a.href = tab._objectUrl;
        a.download = basename(path);
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    // 复制 file:// 链接(与文件树/最近使用面板一致,思源可点击打开)
    // toFileLink 会把思源虚拟路径 /data/... 还原成系统绝对路径,拿不到工作空间时回退原路径
    async function copyLink(): Promise<void> {
        const ok = await copyText(toFileLink(path) || path);
        showMessage(ok ? "已复制文件链接" : "复制失败", 2000, ok ? "info" : "error");
    }

    // ---- 交互:工具栏 ----
    const onToolbarClick = (e: MouseEvent) => {
        const el = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
        if (!el) return;
        switch (el.dataset.action) {
            case "prev":
                if (siblingIndex > 0) goto(siblingIndex - 1);
                break;
            case "next":
                if (siblingIndex >= 0 && siblingIndex < siblings.length - 1) goto(siblingIndex + 1);
                break;
            case "rate":
                cycleRate();
                break;
            case "loop":
                toggleLoop();
                break;
            case "pip":
                togglePip();
                break;
            case "fullscreen":
                toggleFullscreen();
                break;
            case "copy":
                void copyLink();
                break;
            case "save":
                saveAs();
                break;
        }
    };

    // ---- 交互:键盘 ----
    // 与图片 Tab 同款:监听挂在 document 上,多个 Tab 同时打开时只有可见的那个响应。
    // 焦点在播放器自身时交给浏览器原生控制条处理,不重复响应。
    const isActive = () => dom.root.isConnected && dom.root.offsetParent !== null;

    const onKeyDown = (e: KeyboardEvent) => {
        if (!isActive()) return;
        const active = document.activeElement as HTMLElement | null;
        if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
        if (active?.closest?.(".monaco-editor")) return;
        if (active?.closest?.(".syfe-media__stage")) return; // 播放器自带快捷键
        switch (e.key) {
            case " ":
                e.preventDefault();
                togglePlay();
                break;
            case "ArrowLeft":
                e.preventDefault();
                seek(-SEEK_STEP);
                break;
            case "ArrowRight":
                e.preventDefault();
                seek(SEEK_STEP);
                break;
            case "ArrowUp":
                e.preventDefault();
                changeVolume(0.1);
                break;
            case "ArrowDown":
                e.preventDefault();
                changeVolume(-0.1);
                break;
            case "m":
            case "M":
                toggleMute();
                break;
            case "f":
            case "F":
                toggleFullscreen();
                break;
            case "p":
            case "P":
                togglePip();
                break;
            case ",":
            case "<":
                if (siblingIndex > 0) goto(siblingIndex - 1);
                break;
            case ".":
            case ">":
                if (siblingIndex >= 0 && siblingIndex < siblings.length - 1) goto(siblingIndex + 1);
                break;
            default:
                return;
        }
    };

    dom.toolbar.addEventListener("click", onToolbarClick);
    document.addEventListener("keydown", onKeyDown);

    return {
        load,
        dispose() {
            document.removeEventListener("keydown", onKeyDown);
            dom.toolbar.removeEventListener("click", onToolbarClick);
        },
    };
}
