import {openTab, showMessage} from "siyuan";
import {IMAGE_TAB_TYPE} from "../constants";
import {getImageMime, formatFileSize, isImageFile} from "../constants";
import {basename, dirname, joinPath, extname} from "../utils/path";
import {readBinaryFile, readDir} from "../api/file";
import {createBacklinkPanel, BacklinkPanel} from "../components/backlink-panel";

// 图片查看 Tab 所需的插件接口(结构化类型,避免循环依赖)
export interface IPluginForImageTab {
    app: any;
    name: string;
    getOpenedTab(): { [key: string]: any[] };
}

// 图片查看 Tab 实例上附加的字段
interface ImageTabInstance {
    element: HTMLElement;
    data: { path?: string };
    parent?: { updateTitle?: (t: string) => void; headElement?: HTMLElement };
    _path?: string;
    _objectUrl?: string; // 当前图片的 blob URL(destroy / 切换时需释放)
    _disposables?: Array<() => void>;
    _backlink?: BacklinkPanel; // 反向链接面板(同目录切换图片时更新目标)
}

// 缩放范围
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 打开图片查看 Tab(同图片去重,聚焦已有 Tab)
// opts.position 指定时,在指定方向以分栏方式打开
export function openImageTab(plugin: IPluginForImageTab, path: string, opts?: { position?: "right" | "bottom" }): void {
    const opened = plugin.getOpenedTab()[IMAGE_TAB_TYPE] || [];
    const existing = opened.find((c: any) => c?.data?.path === path);
    if (existing) {
        const tab = (existing as any).parent;
        if (tab?.headElement) {
            (tab.headElement as HTMLElement).click();
        }
        return;
    }
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + IMAGE_TAB_TYPE,
            icon: "iconImage",
            title: basename(path),
            data: {path},
        },
        position: opts?.position,
    } as any);
}

// 创建图片查看 addTab 配置(捕获 plugin 闭包)
export function createImageTabConfig(plugin: IPluginForImageTab) {
    return {
        type: IMAGE_TAB_TYPE,
        init(this: ImageTabInstance) {
            const path = this.data?.path;
            if (!path) {
                this.element.innerHTML = `<div class="syfe-empty">未指定图片路径</div>`;
                return;
            }
            this.element.classList.add("syfe-image-tab");
            this._disposables = [];

            const dom = buildViewerDOM(this.element);

            // 反向链接面板(默认收起,展开时懒扫描)
            this._backlink = createBacklinkPanel(plugin as any, path);
            (this.element.querySelector(".syfe-image__backlink") as HTMLElement).appendChild(this._backlink.el);
            this._disposables.push(() => this._backlink?.dispose());

            const viewer = createViewer(dom, plugin, this);
            this._disposables.push(() => viewer.dispose());
            viewer.load(path);
        },
        resize(this: ImageTabInstance) {
            // 处于「适应窗口」模式时,重新计算缩放
            const viewport = this.element.querySelector(".syfe-image__viewport") as HTMLElement | null;
            if (viewport) {
                viewport.dispatchEvent(new Event("syfe-image-refit"));
            }
        },
        destroy(this: ImageTabInstance) {
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

// 释放当前 blob URL
function releaseObjectUrl(tab: ImageTabInstance): void {
    if (tab._objectUrl) {
        try {
            URL.revokeObjectURL(tab._objectUrl);
        } catch {
            // 忽略
        }
        tab._objectUrl = undefined;
    }
}

interface ViewerDOM {
    root: HTMLElement;
    pathLabel: HTMLElement;
    toolbar: HTMLElement;
    zoomLabel: HTMLElement;
    infoLabel: HTMLElement;
    viewport: HTMLElement;
    stage: HTMLElement;
    prevBtn: HTMLButtonElement;
    nextBtn: HTMLButtonElement;
}

// 构建图片查看器 DOM,返回关键节点引用
function buildViewerDOM(container: HTMLElement): ViewerDOM {
    container.innerHTML = `
        <div class="syfe-image">
            <div class="syfe-image__header">
                <span class="syfe-image__pathtext"></span>
            </div>
            <div class="syfe-image__toolbar">
                <button class="b3-button b3-button--text" data-action="prev" title="上一张 (←)">
                    <svg><use xlink:href="#iconLeft"></use></svg>
                </button>
                <button class="b3-button b3-button--text" data-action="next" title="下一张 (→)">
                    <svg><use xlink:href="#iconRight"></use></svg>
                </button>
                <span class="syfe-image__sep"></span>
                <button class="b3-button b3-button--text" data-action="zoom-out" title="缩小 (-)">−</button>
                <button class="b3-button b3-button--text syfe-image__zoom" data-action="reset" title="恢复 100%">100%</button>
                <button class="b3-button b3-button--text" data-action="zoom-in" title="放大 (+)">+</button>
                <button class="b3-button b3-button--text" data-action="fit" title="适应窗口 (/)">适应</button>
                <button class="b3-button b3-button--text" data-action="rotate" title="旋转 90° (R)">旋转</button>
                <span class="syfe-image__sep"></span>
                <button class="b3-button b3-button--text" data-action="copy" title="复制图片到剪贴板">复制</button>
                <button class="b3-button b3-button--text" data-action="save" title="另存为">另存为</button>
                <span class="syfe-image__info"></span>
            </div>
            <div class="syfe-image__backlink"></div>
            <div class="syfe-image__viewport">
                <div class="syfe-image__stage"><div class="syfe-image__hint">加载中...</div></div>
            </div>
        </div>`;

    return {
        root: container.querySelector(".syfe-image") as HTMLElement,
        pathLabel: container.querySelector(".syfe-image__pathtext") as HTMLElement,
        toolbar: container.querySelector(".syfe-image__toolbar") as HTMLElement,
        zoomLabel: container.querySelector(".syfe-image__zoom") as HTMLElement,
        infoLabel: container.querySelector(".syfe-image__info") as HTMLElement,
        viewport: container.querySelector(".syfe-image__viewport") as HTMLElement,
        stage: container.querySelector(".syfe-image__stage") as HTMLElement,
        prevBtn: container.querySelector('[data-action="prev"]') as HTMLButtonElement,
        nextBtn: container.querySelector('[data-action="next"]') as HTMLButtonElement,
    };
}

interface Viewer {
    load(path: string): void;
    dispose(): void;
}

// 图片查看器核心逻辑:加载、缩放、旋转、拖拽平移、同目录切换
function createViewer(dom: ViewerDOM, plugin: IPluginForImageTab, tab: ImageTabInstance): Viewer {
    let path = "";
    let zoom = 1;
    let rotation = 0; // 0 / 90 / 180 / 270
    let fitMode = true;
    let naturalW = 0;
    let naturalH = 0;
    let byteLength = 0;
    let currentBlob: Blob | null = null;

    // 同目录图片列表(用于上一张/下一张)
    let siblings: string[] = [];
    let siblingIndex = -1;
    // 加载令牌,避免快速切换时旧请求覆盖新图片
    let loadToken = 0;

    // ---- 缩放计算 ----
    const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

    function computeFitZoom(): number {
        if (!naturalW || !naturalH) return 1;
        const rotated = rotation % 180 !== 0;
        const w = rotated ? naturalH : naturalW;
        const h = rotated ? naturalW : naturalH;
        const vw = Math.max(dom.viewport.clientWidth - 32, 1);
        const vh = Math.max(dom.viewport.clientHeight - 32, 1);
        return clampZoom(Math.min(vw / w, vh / h, 1));
    }

    function applyTransform(): void {
        const img = dom.stage.querySelector("img") as HTMLImageElement | null;
        if (!img) return;
        if (fitMode) {
            zoom = computeFitZoom();
        }
        img.style.width = `${Math.max(naturalW * zoom, 1)}px`;
        img.style.height = `${Math.max(naturalH * zoom, 1)}px`;
        img.style.transform = rotation ? `rotate(${rotation}deg)` : "";
        dom.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    }

    function updateInfo(): void {
        const parts: string[] = [];
        if (naturalW && naturalH) parts.push(`${naturalW}×${naturalH}`);
        if (byteLength) parts.push(formatFileSize(byteLength));
        parts.push(extname(path).replace(/^\./, "").toUpperCase());
        if (siblings.length > 1 && siblingIndex >= 0) parts.push(`${siblingIndex + 1}/${siblings.length}`);
        dom.infoLabel.textContent = parts.join(" · ");
    }

    function setZoom(z: number, options?: {center?: boolean}): void {
        const prev = zoom;
        zoom = clampZoom(z);
        fitMode = false;
        const img = dom.stage.querySelector("img") as HTMLImageElement | null;
        if (img && options?.center !== false && naturalW && naturalH) {
            // 以视口中心为锚点缩放,保持视觉中心不变
            const vp = dom.viewport;
            const rect = img.getBoundingClientRect();
            const vpRect = vp.getBoundingClientRect();
            const anchorX = vpRect.left + vp.clientWidth / 2;
            const anchorY = vpRect.top + vp.clientHeight / 2;
            const relX = (anchorX - rect.left) / (rect.width || 1);
            const relY = (anchorY - rect.top) / (rect.height || 1);
            const ratio = zoom / (prev || 1);
            vp.scrollLeft += (rect.width * ratio - rect.width) * relX;
            vp.scrollTop += (rect.height * ratio - rect.height) * relY;
        }
        applyTransform();
    }

    function fitToWindow(): void {
        fitMode = true;
        applyTransform();
    }

    function resetZoom(): void {
        fitMode = false;
        zoom = 1;
        applyTransform();
        dom.viewport.scrollTo({left: dom.viewport.scrollWidth / 2 - dom.viewport.clientWidth / 2, top: 0});
    }

    function rotate(): void {
        rotation = (rotation + 90) % 360;
        applyTransform();
        if (fitMode) fitToWindow();
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
                if (!entry.isDir && isImageFile(full)) list.push(full);
            }
            list.sort((a, b) => basename(a).localeCompare(basename(b)));
            siblings = list;
            siblingIndex = list.indexOf(target);
        } catch {
            // 目录不可读时禁用切换按钮
        }
        dom.prevBtn.disabled = siblings.length === 0 || siblingIndex <= 0;
        dom.nextBtn.disabled = siblings.length === 0 || siblingIndex < 0 || siblingIndex >= siblings.length - 1;
    }

    function goto(index: number): void {
        const target = siblings[index];
        if (!target) return;
        // 若目标图片已在其他 Tab 打开,聚焦该 Tab
        const opened = plugin.getOpenedTab()[IMAGE_TAB_TYPE] || [];
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

    // ---- 加载图片 ----
    async function load(target: string): Promise<void> {
        const token = ++loadToken;
        path = target;
        tab._path = target;
        tab.data.path = target;
        // 反向链接面板跟随当前图片
        tab._backlink?.setTarget(target);
        try {
            tab.parent?.updateTitle?.(basename(target));
        } catch {
            // 忽略标题更新失败
        }
        dom.pathLabel.textContent = target;
        dom.pathLabel.title = target;
        dom.stage.innerHTML = `<div class="syfe-image__hint">加载中...</div>`;
        naturalW = 0;
        naturalH = 0;
        byteLength = 0;
        currentBlob = null;
        updateInfo();
        void loadSiblings(target);

        let buf: ArrayBuffer;
        try {
            buf = await readBinaryFile(target);
        } catch (e) {
            if (token !== loadToken) return;
            dom.stage.innerHTML = `
                <div class="syfe-image__error">
                    <div>读取失败: ${escapeHTML(String(e))}</div>
                    <button class="b3-button b3-button--outline" data-retry>重试</button>
                </div>`;
            dom.stage.querySelector("[data-retry]")?.addEventListener("click", () => load(target));
            return;
        }
        if (token !== loadToken) return;

        releaseObjectUrl(tab);
        const blob = new Blob([buf], {type: getImageMime(target)});
        const url = URL.createObjectURL(blob);
        tab._objectUrl = url;
        currentBlob = blob;
        byteLength = buf.byteLength;

        const img = document.createElement("img");
        img.className = "syfe-image__img";
        img.alt = basename(target);
        img.draggable = false;
        img.addEventListener("load", () => {
            if (token !== loadToken) return;
            // 无固有尺寸(如部分 SVG)时回退到容器尺寸
            naturalW = img.naturalWidth || img.clientWidth || 300;
            naturalH = img.naturalHeight || img.clientHeight || 150;
            fitMode = true;
            applyTransform();
            updateInfo();
        });
        img.addEventListener("error", () => {
            if (token !== loadToken) return;
            dom.stage.innerHTML = `<div class="syfe-image__error">图片解码失败,格式可能不受支持</div>`;
        });
        img.src = url;
        dom.stage.innerHTML = "";
        dom.stage.appendChild(img);
        updateInfo();
    }

    // ---- 交互:工具栏 ----
    const onToolbarClick = (e: MouseEvent) => {
        const el = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
        if (!el) return;
        const action = el.dataset.action;
        switch (action) {
            case "zoom-in":
                setZoom(zoom * 1.2);
                break;
            case "zoom-out":
                setZoom(zoom / 1.2);
                break;
            case "reset":
                resetZoom();
                break;
            case "fit":
                fitToWindow();
                break;
            case "rotate":
                rotate();
                break;
            case "prev":
                if (siblingIndex > 0) goto(siblingIndex - 1);
                break;
            case "next":
                if (siblingIndex >= 0 && siblingIndex < siblings.length - 1) goto(siblingIndex + 1);
                break;
            case "copy":
                void copyImage();
                break;
            case "save":
                saveImage();
                break;
        }
    };

    // ---- 交互:滚轮缩放(以指针为锚点) ----
    const onWheel = (e: WheelEvent) => {
        if (!dom.stage.querySelector("img")) return;
        e.preventDefault();
        const img = dom.stage.querySelector("img") as HTMLImageElement;
        const vp = dom.viewport;
        const rect = img.getBoundingClientRect();
        const relX = (e.clientX - rect.left) / (rect.width || 1);
        const relY = (e.clientY - rect.top) / (rect.height || 1);
        const prev = zoom;
        fitMode = false;
        zoom = clampZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        const ratio = zoom / (prev || 1);
        vp.scrollLeft += (rect.width * ratio - rect.width) * relX;
        vp.scrollTop += (rect.height * ratio - rect.height) * relY;
        applyTransform();
    };

    // ---- 交互:拖拽平移 ----
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragScrollLeft = 0;
    let dragScrollTop = 0;

    const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (!dom.stage.querySelector("img")) return;
        dragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragScrollLeft = dom.viewport.scrollLeft;
        dragScrollTop = dom.viewport.scrollTop;
        dom.viewport.classList.add("syfe-image__viewport--grabbing");
        dom.viewport.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
        if (!dragging) return;
        dom.viewport.scrollLeft = dragScrollLeft - (e.clientX - dragStartX);
        dom.viewport.scrollTop = dragScrollTop - (e.clientY - dragStartY);
    };
    const onPointerUp = (e: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        dom.viewport.classList.remove("syfe-image__viewport--grabbing");
        try {
            dom.viewport.releasePointerCapture?.(e.pointerId);
        } catch {
            // 忽略
        }
    };
    const onDoubleClick = () => {
        if (fitMode) resetZoom();
        else fitToWindow();
    };

    // ---- 交互:键盘 ----
    // 注意:监听挂在 document 上,多个图片 Tab 同时打开时只有可见的那个响应,
    // 否则一次按键会让所有 Tab 同时缩放/切换。
    const isActive = () => dom.root.isConnected && dom.root.offsetParent !== null;

    const onKeyDown = (e: KeyboardEvent) => {
        if (!isActive()) return;
        // 输入控件中不拦截
        const active = document.activeElement as HTMLElement | null;
        if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
        // 分屏时焦点在 Monaco 编辑器内,不与其抢按键
        if (active?.closest?.(".monaco-editor")) return;
        switch (e.key) {
            case "+":
            case "=":
                setZoom(zoom * 1.2);
                break;
            case "-":
                setZoom(zoom / 1.2);
                break;
            case "0":
                resetZoom();
                break;
            case "/":
                fitToWindow();
                break;
            case "r":
            case "R":
                rotate();
                break;
            case "ArrowLeft":
                if (siblingIndex > 0) {
                    e.preventDefault();
                    goto(siblingIndex - 1);
                }
                break;
            case "ArrowRight":
                if (siblingIndex >= 0 && siblingIndex < siblings.length - 1) {
                    e.preventDefault();
                    goto(siblingIndex + 1);
                }
                break;
            default:
                return;
        }
    };

    // 复制图片到剪贴板(统一转为 PNG,失败时回退为复制路径)
    async function copyImage(): Promise<void> {
        if (!currentBlob) {
            showMessage("图片尚未加载完成", 2000, "info");
            return;
        }
        try {
            const png = await toPngBlob(currentBlob);
            await navigator.clipboard.write([new ClipboardItem({[png.type || "image/png"]: png})]);
            showMessage("图片已复制到剪贴板", 2000, "info");
        } catch {
            try {
                await navigator.clipboard.writeText(path);
                showMessage("当前环境不支持复制图片,已复制文件路径", 3000, "info");
            } catch {
                showMessage("复制失败", 3000, "error");
            }
        }
    }

    // 另存为(触发浏览器下载)
    function saveImage(): void {
        if (!tab._objectUrl) {
            showMessage("图片尚未加载完成", 2000, "info");
            return;
        }
        const a = document.createElement("a");
        a.href = tab._objectUrl;
        a.download = basename(path);
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    // 视口尺寸变化且处于适应模式时重新适配
    const onRefit = () => {
        if (fitMode) fitToWindow();
    };

    dom.toolbar.addEventListener("click", onToolbarClick);
    dom.viewport.addEventListener("wheel", onWheel, {passive: false});
    dom.viewport.addEventListener("pointerdown", onPointerDown);
    dom.viewport.addEventListener("pointermove", onPointerMove);
    dom.viewport.addEventListener("pointerup", onPointerUp);
    dom.viewport.addEventListener("pointercancel", onPointerUp);
    dom.viewport.addEventListener("dblclick", onDoubleClick);
    dom.viewport.addEventListener("syfe-image-refit", onRefit);
    document.addEventListener("keydown", onKeyDown);

    return {
        load,
        dispose() {
            document.removeEventListener("keydown", onKeyDown);
            dom.toolbar.removeEventListener("click", onToolbarClick);
            dom.viewport.removeEventListener("wheel", onWheel);
            dom.viewport.removeEventListener("pointerdown", onPointerDown);
            dom.viewport.removeEventListener("pointermove", onPointerMove);
            dom.viewport.removeEventListener("pointerup", onPointerUp);
            dom.viewport.removeEventListener("pointercancel", onPointerUp);
            dom.viewport.removeEventListener("dblclick", onDoubleClick);
            dom.viewport.removeEventListener("syfe-image-refit", onRefit);
        },
    };
}

// 将任意图片 Blob 转为 PNG Blob(剪贴板只稳定支持 PNG)
function toPngBlob(blob: Blob): Promise<Blob> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = img.naturalWidth || 300;
                canvas.height = img.naturalHeight || 150;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    reject(new Error("canvas 不可用"));
                    return;
                }
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(b => {
                    if (b) resolve(b);
                    else reject(new Error("转换 PNG 失败"));
                }, "image/png");
            } catch (e) {
                reject(e);
            } finally {
                URL.revokeObjectURL(url);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("图片解码失败"));
        };
        img.src = url;
    });
}
