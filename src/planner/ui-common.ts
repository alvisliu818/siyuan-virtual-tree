// 共享的 UI 片段:DOM 助手、进度环、空态、分区标题、色板。
// Dock 和 Tab 都用同一套,避免两个视图各自长得不一样(这是双入口最容易劣化的地方)。
import {Habit} from "./types";

export function escapeHTML(s: string): string {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** `<input class="b3-text-field">` 助手 */
export function textField(id: string, value = "", placeholder = ""): HTMLElement {
    const input = el("input", "b3-text-field fn__block");
    input.type = "text";
    input.id = id;
    input.value = value;
    input.placeholder = placeholder;
    return input;
}

export function selectField<T extends string>(id: string, options: {value: T; label: string}[], value: T): HTMLElement {
    const sel = el("select", "b3-select fn__block");
    sel.id = id;
    for (const o of options) {
        const opt = el("option", undefined, o.label);
        opt.value = o.value;
        if (o.value === value) opt.selected = true;
        sel.appendChild(opt);
    }
    return sel;
}

export function numberField(id: string, value: number, min = 1, max = 9999): HTMLElement {
    const input = el("input", "b3-text-field fn__block");
    input.type = "number";
    input.id = id;
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    return input;
}

export function checkboxRow(id: string, label: string, checked: boolean, desc?: string): HTMLElement {
    const wrap = el("label", "syfe-pl__switch");
    const input = el("input", "b3-switch") as HTMLInputElement;
    input.type = "checkbox";
    input.id = id;
    input.checked = checked;
    wrap.appendChild(input);
    const txt = el("span", "syfe-pl__switchtext", label);
    wrap.appendChild(txt);
    if (desc) wrap.title = desc;
    return wrap;
}

// ==== 进度环 ====

export interface RingOptions {
    ratio: number;
    size?: number;
    stroke?: number;
    color?: string;
    /** 环中央的主文案 */
    label?: string;
    /** 主文案下的小字 */
    sub?: string;
}

/**
 * 环形进度。用 SVG 的 stroke-dasharray 实现 —— 比 conic-gradient 兼容性好,
 * 也不受 background-clip 在部分 Electron 版本上的坑影响。
 */
export function ringHTML(opts: RingOptions): string {
    const size = opts.size || 44;
    const stroke = opts.stroke || 4;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const ratio = Math.max(0, Math.min(1, opts.ratio || 0));
    const color = opts.color || "var(--b3-theme-primary, #4285f4)";
    const dash = `${(c * ratio).toFixed(2)} ${c.toFixed(2)}`;
    const center = size / 2;
    return `<svg class="syfe-pl__ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        <circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="var(--b3-border-color)" stroke-width="${stroke}" opacity="0.35"></circle>
        <circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="${escapeHTML(color)}" stroke-width="${stroke}"
            stroke-linecap="round" stroke-dasharray="${dash}"
            transform="rotate(-90 ${center} ${center})"></circle>
        ${opts.label ? `<text x="${center}" y="${center}" class="syfe-pl__ringtext" text-anchor="middle" dominant-baseline="central">${escapeHTML(opts.label)}</text>` : ""}
        ${opts.sub ? `<text x="${center}" y="${center + 13}" class="syfe-pl__ringsub" text-anchor="middle" dominant-baseline="central">${escapeHTML(opts.sub)}</text>` : ""}
    </svg>`;
}

/** 细长进度条 */
export function barHTML(ratio: number, color: string, height = 6): string {
    const r = Math.max(0, Math.min(1, ratio || 0));
    return `<div class="syfe-pl__bar" style="height:${height}px">
        <div class="syfe-pl__barfill" style="width:${(r * 100).toFixed(1)}%;background:${escapeHTML(color)}"></div>
    </div>`;
}

// ==== 结构片段 ====

export function emptyState(text: string, hint?: string): string {
    return `<div class="syfe-pl__empty">
        <div class="syfe-pl__emptytext">${escapeHTML(text)}</div>
        ${hint ? `<div class="syfe-pl__emptyhint">${escapeHTML(hint)}</div>` : ""}
    </div>`;
}

/** 带标题与右侧数字的分区容器 */
export function sectionShell(id: string, title: string, extra = ""): HTMLElement {
    const box = el("section", "syfe-pl__section");
    box.id = id;
    const head = el("div", "syfe-pl__sechead");
    head.appendChild(el("span", "syfe-pl__sectitle", title));
    if (extra) head.appendChild(el("span", "syfe-pl__secextra", extra));
    box.appendChild(head);
    box.appendChild(el("div", "syfe-pl__secbody"));
    return box;
}

export function setSectionBody(section: HTMLElement, html: string): void {
    const body = section.querySelector(".syfe-pl__secbody") as HTMLElement | null;
    if (body) body.innerHTML = html;
}

// ==== 色板 / 图标 ====

export const EMOJI_CHOICES = [
    "⭐", "🏃", "📖", "💧", "💪", "🧘", "🛏️", "🌅", "✍️", "🎧",
    "🥗", "💊", "🧹", "🚿", "🚭", "🍵", "🎸", "🗣️", "💰", "🐕",
    "🎯", "🚀", "🏆", "🎓", "🏠", "✈️", "💼", "🎨", "🌱", "⏰",
    "📅", "🎁", "🎂", "💍", "🏖️", "🐣", "⚽", "🧠", "❤️", "🔥",
];

export function colorSwatches(colors: string[], current: string, name: string): string {
    return `<div class="syfe-pl__swatches">${colors.map(c => `
        <span class="syfe-pl__swatch${c === current ? " is-active" : ""}" data-name="${escapeHTML(name)}" data-value="${escapeHTML(c)}"
            style="background:${escapeHTML(c)}"></span>`).join("")}</div>`;
}

export function emojiPicker(current: string, name: string): string {
    return `<div class="syfe-pl__emojis">${EMOJI_CHOICES.map(e => `
        <span class="syfe-pl__emoji${e === current ? " is-active" : ""}" data-name="${escapeHTML(name)}" data-value="${escapeHTML(e)}">${e}</span>`).join("")}</div>`;
}

/**
 * 色板 / emoji 的选中处理( dialogues 里每个选项 UI 都用这一段)。
 * 约定:容器上委派 click,目标元素带 data-name + data-value,选中值写到 `input[name=<name>]`。
 */
export function wirePickers(root: HTMLElement): void {
    root.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const picker = target.closest("[data-name][data-value]") as HTMLElement | null;
        if (!picker) return;
        const name = picker.dataset.name!;
        const value = picker.dataset.value!;
        const parent = picker.parentElement!;
        parent.querySelectorAll(".is-active").forEach(x => x.classList.remove("is-active"));
        picker.classList.add("is-active");
        const input = root.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
        if (input) input.value = value;
    });
}

/** 习惯的小徽章:圆点 + 名字 */
export function habitChip(habit: Habit): string {
    return `<span class="syfe-pl__chip" title="${escapeHTML(habit.name)}">
        <span class="syfe-pl__chipdot" style="background:${escapeHTML(habit.color)}"></span>
        <span class="syfe-pl__chiptext">${escapeHTML(habit.icon)} ${escapeHTML(habit.name)}</span>
    </span>`;
}
