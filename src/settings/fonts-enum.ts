// 「字体族」选择器的全量字体枚举:Node 侧列字体目录 + 解析字体文件 name 表。
//
// 为什么不用 queryLocalFonts:思源 Electron 未配 local-fonts 权限 handler 时默认拒绝;
// 即使放行(用户实机可见+手势时成功),它返回的 family 也只有 137 个,
// 比本文件的文件解析(209 个)残缺 —— 这个 API 的返回本身就不全,不能当数据源。
// 本插件跑在思源 renderer(nodeIntegration)→ 解析系统字体文件拿真实 family 名,
// 兜底:本文件(主力,真实全量) > canvas 候选探测(editor-settings-ui.ts)。
import {getNativeRequire} from "../utils/native-require";

// 会话内缓存:字体安装变化极少,没必要每次点"+"都扫盘
let cachedFamilies: string[] | null = null;

/** 各平台系统字体目录(存在才扫;统一递归限深,覆盖 linux 嵌套树与 Windows 用户级字体) */
function fontDirs(): string[] {
    try {
        const req = getNativeRequire();
        if (!req) return [];
        const path = req("path");
        const os = req("os");
        const home = os.homedir();
        switch (process.platform) {
            case "win32":
                return [
                    path.join(process.env.WINDIR || "C:\\Windows", "Fonts"),
                    path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Microsoft", "Windows", "Fonts"),
                ];
            case "darwin":
                return ["/System/Library/Fonts", "/Library/Fonts", path.join(home, "Library", "Fonts")];
            default:
                return [
                    "/usr/share/fonts", "/usr/local/share/fonts",
                    path.join(home, ".fonts"), path.join(home, ".local", "share", "fonts"),
                ];
        }
    } catch {
        return [];
    }
}

/** 枚举系统全部字体族(读字体文件内部 name 表,真实全量)。失败/不可用返回 []。 */
export async function enumFontFamiliesViaFs(): Promise<string[]> {
    if (cachedFamilies) return cachedFamilies;
    const req = getNativeRequire();
    if (!req) return [];
    let fs: any;
    let path: any;
    try {
        fs = req("fs");
        path = req("path");
    } catch {
        return [];
    }

    // 收集字体文件(递归限深 4 层)
    const files: string[] = [];
    const walk = (dir: string, depth: number): void => {
        let entries: any[];
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true});
        } catch {
            return;
        }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (depth < 4) walk(p, depth + 1);
                continue;
            }
            if (e.isFile() && /\.(ttf|otf|ttc|otc)$/i.test(e.name)) files.push(p);
        }
    };
    for (const dir of fontDirs()) walk(dir, 0);
    if (!files.length) return [];

    const fams = new Set<string>();
    for (const f of files) {
        try {
            await collectFamilyNames(fs, f, fams);
        } catch {
            // 单个坏文件不影响整体
        }
    }
    const out = [...fams].map(s => s.trim()).filter(s => s.length > 0 && s.length < 64);
    out.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    if (out.length) cachedFamilies = out;
    return out;
}

/** 收集单个字体文件(ttf/otf/ttc 集合)里全部 family 名(nameID 1/16) */
async function collectFamilyNames(fs: any, file: string, out: Set<string>): Promise<void> {
    const fh = await fs.promises.open(file, "r");
    try {
        const head = Buffer.alloc(12);
        if ((await fh.read(head, 0, 12, 0)).bytesRead < 12) return;
        if (head.readUInt32BE(0) === 0x74746366) {
            // 'ttcf' 字体集合(ttc/otc):头 12 字节后是每字体 sfnt 偏移表。
            // 注意:子字体表目录里的表 offset 是相对【TTC 文件开头】的(OpenType 规范),
            // 不是相对子字体头 —— base 必须传 0,否则 name 表定位错位读出乱码。
            const numFonts = Math.min(head.readUInt32BE(8), 32);
            const offs = Buffer.alloc(numFonts * 4);
            if ((await fh.read(offs, 0, offs.length, 12)).bytesRead < offs.length) return;
            for (let i = 0; i < numFonts; i++) {
                await readSfntNames(fh, offs.readUInt32BE(i * 4), 0, out);
            }
        } else {
            await readSfntNames(fh, 0, 0, out);
        }
    } finally {
        await fh.close();
    }
}

/** 解析 sfnt(12B 头 + 表目录)的 name 表,收 family 名。
 *  sfntOffset:子字体头位置;nameBase:表 offset 的基准(单字体=文件 0,TTC 集合=文件 0)。
 *  nameID 1=family,16=preferred family;en/zh 记录都收(搜中英文名都能命中),Set 去重。 */
async function readSfntNames(fh: any, sfntOffset: number, nameBase: number, out: Set<string>): Promise<void> {
    const head = Buffer.alloc(12);
    if ((await fh.read(head, 0, 12, sfntOffset)).bytesRead < 12) return;
    // sfnt version 校验:0x00010000(TrueType)/'OTTO'(CFF)/'true'(旧 TrueType)
    const version = head.readUInt32BE(0);
    if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) return;
    const numTables = Math.min(head.readUInt16BE(4), 512);
    const dir = Buffer.alloc(numTables * 16);
    if ((await fh.read(dir, 0, dir.length, sfntOffset + 12)).bytesRead < dir.length) return;
    let nameOff = -1;
    let nameLen = 0;
    for (let i = 0; i < numTables; i++) {
        if (dir.readUInt32BE(i * 16) === 0x6e616d65) { // 'name'
            nameOff = dir.readUInt32BE(i * 16 + 8);
            nameLen = dir.readUInt32BE(i * 16 + 12);
            break;
        }
    }
    // name 表上限 1MB:正常几十 KB,防异常文件读爆内存
    if (nameOff < 0 || nameLen <= 0 || nameLen > 1 << 20) return;
    const nameBuf = Buffer.alloc(nameLen);
    if ((await fh.read(nameBuf, 0, nameLen, nameBase + nameOff)).bytesRead < 6) return;
    // name 表 format 必须 0(format 1 带 lang-tag 记录,几乎不存在;其他值=定位已错)
    if (nameBuf.readUInt16BE(0) !== 0) return;
    const count = Math.min(nameBuf.readUInt16BE(2), 512);
    const stringOffset = nameBuf.readUInt16BE(4);
    for (let i = 0; i < count; i++) {
        const rec = 6 + i * 12;
        if (rec + 12 > nameBuf.length) break;
        const platformID = nameBuf.readUInt16BE(rec);
        // Macintosh 平台记录是 ASCII/latin1,中文字体往里塞 GBK 字节,解码必乱;
        // 而 Windows/Unicode 记录(nameID 1)按规范必有 → 只信 platform 0/3
        if (platformID !== 0 && platformID !== 3) continue;
        const nameID = nameBuf.readUInt16BE(rec + 6);
        if (nameID !== 1 && nameID !== 16) continue;
        // 语言白名单:en-US/zh-CN/unspecified。每个字体必有 en 记录(不会漏字体),
        // 而个别坏文件被误读出的二进制噪声 family 名,其 languageID 基本是随机值 → 顺带滤掉。
        const languageID = nameBuf.readUInt16BE(rec + 4);
        if (languageID !== 0x0409 && languageID !== 0x0804 && languageID !== 0x0000) continue;
        const len = nameBuf.readUInt16BE(rec + 8);
        const off = nameBuf.readUInt16BE(rec + 10);
        if (stringOffset + off + len > nameBuf.length) continue;
        const name = decodeNameString(platformID, nameBuf.slice(stringOffset + off, stringOffset + off + len));
        // 正常 family 名 ≥2 字符且不含控制字符(滤掉解出二进制碎片的坏记录)
        if (name && name.length >= 2 && !/[\u0000-\u001F\u007F]/.test(name)) out.add(name);
    }
}

/** name 表字符串解码:Windows/Unicode 平台(platform 0/3)是 UTF-16BE */
function decodeNameString(platformID: number, raw: Buffer): string {
    if (!raw.length) return "";
    if (platformID === 0 || platformID === 3) {
        let s = "";
        for (let i = 0; i + 1 < raw.length; i += 2) {
            s += String.fromCharCode(raw.readUInt16BE(i));
        }
        return s;
    }
    return raw.toString("latin1");
}
