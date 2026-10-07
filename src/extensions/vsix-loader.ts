// VSIX 文件解包器
// .vsix 本质是 ZIP 压缩包,结构:
//   extension/
//   ├── package.json
//   ├── extension.vsixmanifest (XML 清单)
//   ├── [icon].png
//   ├── syntaxes/*.tmLanguage.json
//   ├── themes/*.json
//   ├── snippets/*.json
//   └── out/ (编译后的扩展代码)
// 使用 JSZip 解压并提取关键文件
import JSZip from "jszip";
import {InstalledExtension, Contributes} from "./types";

// VSIX 内 package.json 的结构
interface VsixPackageJson {
    name: string;
    publisher?: string;
    version: string;
    displayName?: string;
    description?: string;
    engines?: {vscode?: string};
    contributes?: Contributes;
    main?: string;
    activationEvents?: string[];
}

// 解压 .vsix 并提取扩展信息
export async function parseVsix(
    vsixBuffer: ArrayBuffer,
    namespace: string,
    extensionName: string,
    version: string,
): Promise<InstalledExtension> {
    const zip = await JSZip.loadAsync(vsixBuffer);

    // VSIX 中文件路径通常以 extension/ 开头
    // 找到 package.json
    const packagePath = await findFile(zip, "package.json");
    if (!packagePath) {
        throw new Error("VSIX 中未找到 package.json");
    }

    const pkgContent = await zip.file(packagePath)!.async("string");
    const pkg: VsixPackageJson = JSON.parse(pkgContent);

    // 提取 contributes 中引用的文件(语法/主题/snippet)
    const files: Record<string, string> = {};
    const contributes = pkg.contributes || {};

    // 收集需要提取的文件路径
    const filePaths = new Set<string>();
    if (contributes.grammars) {
        for (const g of contributes.grammars) {
            if (g.path) filePaths.add(normalizePath(g.path));
        }
    }
    if (contributes.themes) {
        for (const t of contributes.themes) {
            if (t.path) filePaths.add(normalizePath(t.path));
        }
    }
    if (contributes.snippets) {
        for (const s of contributes.snippets) {
            if (s.path) filePaths.add(normalizePath(s.path));
        }
    }

    // 提取文件内容
    const basePath = getBasePath(packagePath); // 去掉末尾的 package.json
    for (const fp of filePaths) {
        const fullPath = basePath ? `${basePath}/${fp}` : fp;
        const file = zip.file(fullPath) || zip.file(`extension/${fp}`);
        if (file) {
            try {
                files[fp] = await file.async("string");
            } catch {
                // 跳过无法读取的文件
            }
        }
    }

    // 提取 iconTheme 引用的 SVG 图标文件
    // iconTheme JSON 中 iconDefinitions 引用 .svg 文件,需要单独提取
    // iconPath 是相对于 iconTheme JSON 文件所在目录的路径,可能包含 . 和 ..
    if (contributes.iconThemes) {
        for (const it of contributes.iconThemes) {
            if (!it.path) continue;
            const themePath = normalizePath(it.path);
            const themeFile = findFileInZip(zip, themePath, basePath);
            if (!themeFile) {
                console.warn(`[siyuan-file-editor] VSIX 中未找到图标主题文件: ${themePath}`);
                continue;
            }

            let themeData: any;
            try {
                const themeContent = await themeFile.async("string");
                files[themePath] = themeContent;
                themeData = JSON.parse(themeContent);
            } catch (e) {
                console.error(`[siyuan-file-editor] 解析图标主题失败 ${themePath}:`, e);
                continue;
            }

            // 解析 iconDefinitions,提取引用的 SVG 文件
            // iconPath 相对于主题文件所在目录,可能包含 ./ 与 ../
            const themeDir = getDirPath(themePath);
            const iconDefs = themeData.iconDefinitions || {};
            const defEntries = Object.entries(iconDefs) as [string, any][];
            let extracted = 0;
            let failed = 0;
            for (const [name, def] of defEntries) {
                if (!def?.iconPath) continue;
                const iconRelPath = resolveRelativePath(themeDir, def.iconPath);
                if (files[iconRelPath] !== undefined) {
                    extracted++; // 多个定义可能引用同一 SVG,已提取则跳过
                    continue;
                }
                const iconFile = findFileInZip(zip, iconRelPath, basePath);
                if (!iconFile) {
                    failed++;
                    continue;
                }
                try {
                    files[iconRelPath] = await iconFile.async("string");
                    extracted++;
                } catch (e) {
                    failed++;
                    console.warn(`[siyuan-file-editor] 读取图标失败 ${iconRelPath}:`, e);
                }
            }
            if (defEntries.length > 0 && extracted === 0) {
                // 主题声明了图标却一个都没提取到 —— 图标必然无法显示,需要显式暴露
                console.error(
                    `[siyuan-file-editor] 图标主题 ${themePath} 声明了 ${defEntries.length} 个图标定义,` +
                    `但一个 SVG 都没提取到(未找到 ${failed} 个),请检查 VSIX 结构`,
                );
            } else if (failed > 0) {
                console.warn(`[siyuan-file-editor] 图标主题 ${themePath}: 提取 ${extracted} 个,缺失 ${failed} 个`);
            }
        }
    }

    // 保存 package.json 本身
    files["package.json"] = pkgContent;

    // 提取图标(如有)
    let icon: string | undefined;
    if (pkg.name) {
        // 尝试常见图标路径
        const iconPaths = ["icon.png", "images/icon.png", "resources/icon.png", "media/icon.png"];
        for (const ip of iconPaths) {
            const fullPath = basePath ? `${basePath}/${ip}` : ip;
            const file = zip.file(fullPath) || zip.file(`extension/${ip}`);
            if (file) {
                try {
                    const iconBuf = await file.async("base64");
                    icon = `data:image/png;base64,${iconBuf}`;
                    break;
                } catch {
                    // 跳过
                }
            }
        }
    }

    // 从 vsixmanifest 提取图标(备用方案)
    if (!icon) {
        const manifestPath = await findFile(zip, "extension.vsixmanifest");
        if (manifestPath) {
            const manifestContent = await zip.file(manifestPath)!.async("string");
            // 用 [\s\S]*? 而不是 s 标志:tsc 的 target 是 es6,不认 es2018 的 dotAll
            const iconMatch = manifestContent.match(/<Property\s+Id="Assets">[\s\S]*?Asset[\s\S]*?Path="([^"]+)"/);
            if (iconMatch) {
                const iconPath = iconMatch[1].replace(/^\.\//, "");
                const fullPath = basePath ? `${basePath}/${iconPath}` : iconPath;
                const file = zip.file(fullPath) || zip.file(`extension/${iconPath}`);
                if (file) {
                    try {
                        const iconBuf = await file.async("base64");
                        const ext = iconPath.split(".").pop()?.toLowerCase() || "png";
                        icon = `data:image/${ext};base64,${iconBuf}`;
                    } catch {
                        // 跳过
                    }
                }
            }
        }
    }

    return {
        id: `${namespace}.${extensionName}`,
        namespace,
        name: extensionName,
        version: version || pkg.version || "0.0.0",
        displayName: pkg.displayName || pkg.name || extensionName,
        description: pkg.description || "",
        icon,
        enabled: true,
        installedAt: Date.now(),
        files,
        contributes,
    };
}

// 在 ZIP 中查找文件(模糊匹配文件名)
async function findFile(zip: JSZip, filename: string): Promise<string | null> {
    const paths: string[] = [];
    zip.forEach((relativePath) => {
        if (relativePath.endsWith(filename) && !relativePath.startsWith("__MACOSX")) {
            paths.push(relativePath);
        }
    });
    // 优先选择 extension/ 前缀的路径
    const preferred = paths.find(p => p.startsWith("extension/")) || paths[0];
    return preferred || null;
}

// 规范化路径(去掉开头的 ./)
function normalizePath(p: string): string {
    return p.replace(/^\.\//, "").replace(/^\//, "");
}

// 获取基础路径(package.json 所在目录)
function getBasePath(packagePath: string): string {
    const parts = packagePath.split("/");
    parts.pop(); // 去掉 package.json
    return parts.join("/");
}

// 获取文件所在目录(相对于 extension 根)
function getDirPath(filePath: string): string {
    const parts = filePath.split("/");
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

// 在 ZIP 中查找文件(尝试多种路径前缀,最后模糊匹配文件名)
function findFileInZip(zip: JSZip, relPath: string, basePath: string): JSZip.JSZipObject | null {
    // 精确匹配:尝试 basePath/relPath, extension/relPath, relPath
    const candidates = [
        basePath ? `${basePath}/${relPath}` : null,
        `extension/${relPath}`,
        relPath,
    ].filter(Boolean) as string[];
    for (const p of candidates) {
        const file = zip.file(p);
        if (file) return file;
    }
    // 模糊匹配:按文件名查找(作为最后手段)
    const fileName = relPath.split("/").pop();
    if (fileName) {
        let foundPath: string | null = null;
        zip.forEach((relativePath) => {
            if (!foundPath && relativePath.endsWith(fileName) && !relativePath.startsWith("__MACOSX")) {
                foundPath = relativePath;
            }
        });
        if (foundPath) return zip.file(foundPath);
    }
    return null;
}
