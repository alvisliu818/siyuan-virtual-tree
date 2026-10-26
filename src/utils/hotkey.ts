// 自定义快捷键组合的解析 / 匹配 / 录入(音视频播放器时间戳快捷键等共用)。
//
// 存储格式为规范串:修饰键按 Ctrl+Alt+Shift+Meta 顺序在前,主键在后,
// 如 "K"、"Shift+K"、"Ctrl+Alt+P"、"F2"。解析对大小写与别名宽容
// ("ctrl+k"、"CTRL + ALT + K" 均可),落盘前统一规范化。
// 空串 = 未设置(禁用该快捷键)。

export interface HotkeyDef {
    /** 主键,与 KeyboardEvent.key 同名;空格存为 "Space" */
    key: string;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
}

const MOD_ALIASES: Record<string, "ctrl" | "alt" | "shift" | "meta"> = {
    ctrl: "ctrl",
    control: "ctrl",
    alt: "alt",
    option: "alt",
    shift: "shift",
    meta: "meta",
    cmd: "meta",
    command: "meta",
    win: "meta",
    super: "meta",
};

// 单独按下不算组合(录入时忽略,解析时视为非法)
const PURE_MOD_KEYS = new Set([
    "control", "alt", "shift", "meta", "altgraph",
    "fn", "fnlock", "capslock", "numlock", "scrolllock", "contextmenu",
]);

// 解析别名:"+" 无法直接写进组合串,用 plus;空格/Escape 等给常用缩写
const KEY_PARSE: Record<string, string> = {
    space: " ",
    spacebar: " ",
    esc: "escape",
    del: "delete",
    plus: "+",
};

function defToText(def: HotkeyDef): string {
    const parts: string[] = [];
    if (def.ctrl) parts.push("Ctrl");
    if (def.alt) parts.push("Alt");
    if (def.shift) parts.push("Shift");
    if (def.meta) parts.push("Meta");
    parts.push(def.key === " " ? "Space" : def.key);
    return parts.join("+");
}

/** 任意用户输入 → 规范串;为空或无法解析返回 ""(语义为禁用) */
export function normalizeHotkeyText(raw: string): string {
    const parts = String(raw ?? "").split("+").map(s => s.trim()).filter(s => s.length > 0);
    if (parts.length === 0) return "";
    const def: HotkeyDef = {key: "", ctrl: false, alt: false, shift: false, meta: false};
    for (let i = 0; i < parts.length; i++) {
        const low = parts[i].toLowerCase();
        if (i < parts.length - 1) {
            const mod = MOD_ALIASES[low];
            if (!mod || def[mod]) return ""; // 未知修饰键 / 重复修饰键
            def[mod] = true;
        } else {
            if (PURE_MOD_KEYS.has(low) || MOD_ALIASES[low]) return ""; // 只有修饰键没有主键
            def.key = KEY_PARSE[low] !== undefined
                ? KEY_PARSE[low]
                : (parts[i].length === 1 ? parts[i].toUpperCase() : parts[i]);
        }
    }
    return def.key ? defToText(def) : "";
}

/** 配置值 → 匹配用结构;未设置/空串返回 null(禁用) */
export function parseHotkey(raw: string | undefined | null): HotkeyDef | null {
    const text = normalizeHotkeyText(String(raw ?? ""));
    if (!text) return null;
    const def: HotkeyDef = {key: "", ctrl: false, alt: false, shift: false, meta: false};
    for (const part of text.split("+")) {
        const mod = MOD_ALIASES[part.toLowerCase()];
        if (mod) {
            def[mod] = true;
            continue;
        }
        def.key = part === "Space" ? " " : part;
    }
    return def.key ? def : null;
}

/** 事件是否命中:单字符主键忽略大小写,其余精确匹配;修饰键要求完全一致 */
export function hotkeyMatches(e: KeyboardEvent, def: HotkeyDef): boolean {
    if (def.key.length === 1 && e.key.length === 1) {
        if (e.key.toLowerCase() !== def.key.toLowerCase()) return false;
    } else if (e.key !== def.key) {
        return false;
    }
    return e.ctrlKey === def.ctrl && e.altKey === def.alt
        && e.shiftKey === def.shift && e.metaKey === def.meta;
}

/** 键盘事件 → 规范串(录入用);纯修饰键返回 ""(调用方忽略) */
export function hotkeyFromEvent(e: KeyboardEvent): string {
    if (PURE_MOD_KEYS.has(e.key.toLowerCase())) return "";
    return defToText({
        key: e.key,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey,
    });
}

/** 显示用(规范化);空 = 未设置 */
export function formatHotkey(raw: string | undefined | null): string {
    return normalizeHotkeyText(String(raw ?? ""));
}
