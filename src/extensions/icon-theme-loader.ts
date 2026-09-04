// 文件图标主题加载器
// 解析 VSCode iconTheme JSON,将 SVG 图标应用到文件树和编辑器 Tab
// VSCode iconTheme JSON 结构:
//   {
//     "iconDefinitions": {
//       "folder": { "iconPath": "./icons/folder.svg" },
//       "typescript": { "iconPath": "./icons/file_type_typescript.svg" }
//     },
//     "folder": "folder",
//     "file": "file",
//     "fileExtensions": { "ts": "typescript", "tsx": "typescript" },
//     "fileNames": { "package.json": "npm" },
//     "languageIds": { "typescript": "typescript" }
//   }
import {InstalledExtension} from "./types";

// 图标解析结果:返回 data URI 或 null(回退到默认图标)
export interface IconInfo {
    dataUri: string; // SVG 的 data URI
    width?: number;
    height?: number;
}

// 已加载的图标主题
interface LoadedIconTheme {
    extensionId: string;
    label: string;
    // iconDefinition name → SVG data URI
    icons: Map<string, string>;
    // 默认文件夹图标(折叠状态)
    folderIcon?: string;
    // 默认文件夹图标(展开状态)
    folderExpandedIcon?: string;
    // 默认文件图标
    fileIcon?: string;
    // 扩展名 → iconDefinition name
    fileExtensions: Map<string, string>;
    // 文件名 → iconDefinition name
    fileNames: Map<string, string>;
    // languageId → iconDefinition name
    languageIds: Map<string, string>;
    // 文件夹名 → iconDefinition name(折叠状态)
    folderNames: Map<string, string>;
    // 文件夹名 → iconDefinition name(展开状态)
    folderNamesExpanded: Map<string, string>;
    // 主题声明了图标定义但一个都没解析出来(安装数据缺 SVG)
    iconsMissing?: boolean;
}

// 当前激活的图标主题
let activeIconTheme: LoadedIconTheme | null = null;
// 所有已加载的图标主题(供 UI 选择)
const loadedIconThemes: LoadedIconTheme[] = [];

// 加载扩展的图标主题贡献
export function loadIconThemes(extension: InstalledExtension): number {
    const contributes = extension.contributes;
    if (!contributes?.iconThemes || contributes.iconThemes.length === 0) return 0;

    let count = 0;
    for (const iconThemeContribution of contributes.iconThemes) {
        try {
            const themePath = normalizePath(iconThemeContribution.path);
            const content = extension.files[themePath];
            if (!content) {
                console.warn(`[siyuan-file-editor] 图标主题文件未找到: ${iconThemeContribution.path}`);
                continue;
            }
            const themeData = JSON.parse(content);
            const theme = parseIconTheme(themeData, extension, themePath);
            theme.extensionId = extension.id;
            theme.label = iconThemeContribution.label;
            // 主题声明了图标定义,却一个都没解析出来 —— 说明安装数据里缺 SVG
            // (常见于旧版本安装,或解包时 SVG 提取失败),此时需提示用户重装扩展
            theme.iconsMissing =
                Object.keys(themeData.iconDefinitions || {}).length > 0 && theme.icons.size === 0;
            loadedIconThemes.push(theme);
            count++;

            if (theme.iconsMissing) {
                console.warn(
                    `[siyuan-file-editor] 图标主题「${theme.label}」的 SVG 图标缺失,` +
                    `扩展 ${extension.id} 可能是在旧版本中安装的,请在扩展市场重新安装该扩展`,
                );
            }

            // 第一个加载的图标主题自动激活
            if (!activeIconTheme) {
                activeIconTheme = theme;
                console.log(`[siyuan-file-editor] 图标主题已激活: ${theme.label} (图标数: ${theme.icons.size})`);
            }
        } catch (e) {
            console.error(`[siyuan-file-editor] 加载图标主题失败 ${iconThemeContribution.path}:`, e);
        }
    }
    return count;
}

// 解析图标主题 JSON
function parseIconTheme(
    themeData: any,
    extension: InstalledExtension,
    themePath: string,
): LoadedIconTheme {
    const icons = new Map<string, string>();
    const iconDefs = themeData.iconDefinitions || {};
    const themeDir = getBasePath(themePath); // 主题文件所在目录(相对于 extension 根)

    for (const [name, def] of Object.entries(iconDefs) as [string, any][]) {
        if (def.iconPath) {
            // 解析 iconPath 相对于主题文件目录,得到相对于 extension 根的路径
            // 必须与 vsix-loader.ts 中的存储逻辑保持一致
            const iconRelPath = resolveRelativePath(themeDir, def.iconPath);
            const svgContent = extension.files[iconRelPath];
            if (svgContent) {
                icons.set(name, svgToDataUri(svgContent));
            }
        }
    }

    return {
        extensionId: "",
        label: "",
        icons,
        folderIcon: themeData.folder,
        folderExpandedIcon: themeData.folderExpanded,
        fileIcon: themeData.file,
        fileExtensions: mapToMap(themeData.fileExtensions),
        fileNames: mapToMap(themeData.fileNames),
        languageIds: mapToMap(themeData.languageIds),
        folderNames: mapToMap(themeData.folderNames),
        folderNamesExpanded: mapToMap(themeData.folderNamesExpanded),
    };
}

// 将 Record<string,string> 转为 Map<string,string>
function mapToMap(obj: Record<string, string> | undefined): Map<string, string> {
    const m = new Map<string, string>();
    if (obj) {
        for (const [k, v] of Object.entries(obj)) {
            m.set(k.toLowerCase(), v);
        }
    }
    return m;
}

// SVG 内容转 data URI
function svgToDataUri(svg: string): string {
    // 直接使用 encodeURIComponent 编码 SVG,比 base64 更小
    // 移除 XML 声明和注释以减小体积
    const cleaned = svg.replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "").trim();
    return `data:image/svg+xml,${encodeURIComponent(cleaned)}`;
}

// 获取文件夹图标
// name: 文件夹名(用于按名称匹配,如 src → folder-src 图标)
// expanded: 是否展开状态(展开状态使用不同的图标)
export function getFolderIcon(name?: string, expanded?: boolean): string | null {
    if (!activeIconTheme) return null;

    // 1. 优先按文件夹名匹配
    if (name) {
        const lowerName = name.toLowerCase();
        const folderNameMap = expanded
            ? activeIconTheme.folderNamesExpanded
            : activeIconTheme.folderNames;
        const nameIcon = folderNameMap.get(lowerName);
        if (nameIcon) {
            const icon = activeIconTheme.icons.get(nameIcon);
            if (icon) return icon;
        }
    }

    // 2. 回退到默认文件夹图标
    const defaultIconKey = expanded
        ? activeIconTheme.folderExpandedIcon
        : activeIconTheme.folderIcon;
    if (defaultIconKey) {
        const icon = activeIconTheme.icons.get(defaultIconKey);
        if (icon) return icon;
    }

    // 3. 如果展开状态图标不存在,回退到折叠状态图标
    if (expanded && activeIconTheme.folderIcon) {
        const icon = activeIconTheme.icons.get(activeIconTheme.folderIcon);
        if (icon) return icon;
    }

    return null;
}

// 根据文件名获取文件图标
export function getFileIconFor(name: string): string | null {
    if (!activeIconTheme) return null;

    const lowerName = name.toLowerCase();

    // 1. 优先精确匹配文件名
    const fileNameIcon = activeIconTheme.fileNames.get(lowerName);
    if (fileNameIcon) {
        const icon = activeIconTheme.icons.get(fileNameIcon);
        if (icon) return icon;
    }

    // 2. 扩展名匹配
    const dotIdx = name.lastIndexOf(".");
    if (dotIdx > 0) {
        const ext = name.slice(dotIdx + 1).toLowerCase();
        const extIcon = activeIconTheme.fileExtensions.get(ext);
        if (extIcon) {
            const icon = activeIconTheme.icons.get(extIcon);
            if (icon) return icon;
        }
    }

    // 3. 回退到默认文件图标
    if (activeIconTheme.fileIcon) {
        const icon = activeIconTheme.icons.get(activeIconTheme.fileIcon);
        if (icon) return icon;
    }

    return null;
}

// 是否有图标主题已激活
export function hasActiveIconTheme(): boolean {
    return activeIconTheme !== null;
}

// 获取所有已加载的图标主题
export function getLoadedIconThemes(): {extensionId: string; label: string}[] {
    return loadedIconThemes.map(t => ({extensionId: t.extensionId, label: t.label}));
}

// 获取"声明了图标定义但 SVG 全部缺失"的主题(安装数据不完整,需重装扩展)
export function getIconThemesWithMissingIcons(): {extensionId: string; label: string}[] {
    return loadedIconThemes
        .filter(t => t.iconsMissing)
        .map(t => ({extensionId: t.extensionId, label: t.label}));
}

// 激活指定图标主题
export function activateIconTheme(extensionId: string): boolean {
    const theme = loadedIconThemes.find(t => t.extensionId === extensionId);
    if (theme) {
        activeIconTheme = theme;
        return true;
    }
    return false;
}

// 按用户偏好激活图标主题
// pref: "" = 自动(第一个);"__none__" = 不使用扩展图标主题;其他 = 扩展 id
// 返回是否激活了扩展图标主题(调用方据此决定是否刷新文件树)
export function activateIconThemeByPreference(pref: string): boolean {
    if (pref === "__none__") {
        activeIconTheme = null;
        return false;
    }
    if (pref) {
        if (activateIconTheme(pref)) return true;
        // 指定的主题已不存在(扩展被卸载)→ 回退自动
    }
    if (loadedIconThemes.length > 0) {
        activeIconTheme = loadedIconThemes[0];
        return true;
    }
    activeIconTheme = null;
    return false;
}

// 当前激活的图标主题 id(无则 null)
export function getActiveIconThemeId(): string | null {
    return activeIconTheme ? activeIconTheme.extensionId : null;
}

// 移除扩展的图标主题
export function removeExtensionIconThemes(extensionId: string): void {
    const idx = loadedIconThemes.findIndex(t => t.extensionId === extensionId);
    if (idx >= 0) {
        // 如果移除的是当前激活的主题,回退到第一个
        if (activeIconTheme?.extensionId === extensionId) {
            activeIconTheme = loadedIconThemes.find(t => t.extensionId !== extensionId) || null;
        }
        loadedIconThemes.splice(idx, 1);
    }
}

// 清理所有图标主题
export function clearAllIconThemes(): void {
    loadedIconThemes.length = 0;
    activeIconTheme = null;
}

function normalizePath(p: string): string {
    return p.replace(/^\.\//, "").replace(/^\//, "");
}

function getBasePath(path: string): string {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/");
}

// 解析相对路径,处理 . 和 ..
// baseDir: 基准目录(相对于 extension 根)
// relPath: 相对于 baseDir 的路径(可能包含 ./ ../)
// 返回: 相对于 extension 根的规范化路径
function resolveRelativePath(baseDir: string, relPath: string): string {
    const normalized = normalizePath(relPath);
    const parts = normalized.split("/");
    const result = baseDir ? baseDir.split("/").filter(Boolean) : [];
    for (const part of parts) {
        if (part === "..") {
            result.pop();
        } else if (part !== ".") {
            result.push(part);
        }
    }
    return result.join("/");
}
