// 思源虚拟路径与系统文件系统路径的相互转换
import {isSiyuanPath, basename} from "./path";

// 获取思源工作空间的绝对路径
export function getWorkspacePath(): string {
    const w = window as any;
    return w?.siyuan?.config?.system?.workspaceDir || "";
}

// 将思源虚拟路径(/data/...)转换为系统文件系统路径
// siyuanPath: 思源虚拟路径,如 /data/public/foo
// workspacePath: 思源工作空间系统路径,如 E:\HOME\SiYuan(可选,缺省时自动获取)
// 返回: 系统路径,如 E:\HOME\SiYuan\data\public\foo
// 注意:非思源虚拟路径(Windows 盘符/UNC/POSIX 绝对路径)原样返回,
// 否则会把 E:\HOME\... 错误拼成 工作空间+E:\HOME\... 这种非法路径
export function toSystemPath(siyuanPath: string, workspacePath?: string): string {
    if (!isSiyuanPath(siyuanPath)) return siyuanPath;
    if (!workspacePath) {
        workspacePath = getWorkspacePath();
    }
    if (!workspacePath) {
        // 拿不到工作空间时返回原路径(调用方需自行兜底)
        return siyuanPath;
    }
    const relPath = siyuanPath.replace(/^\/+/, "");
    const wsNormalized = workspacePath.replace(/[\\/]+$/, "");
    const sep = wsNormalized.includes("\\") ? "\\" : "/";
    return wsNormalized + sep + relPath.replace(/\//g, sep);
}

// 将系统绝对路径转换为 file:// 协议链接(原始路径,不 percent-编码)
// 重要:思源笔记 v3.1.21 起明确不支持 percent-编码(如 %20/%E5%B0..)的 file:// 链接,
// Windows 资源管理器/ShellExecute 不解码 percent-编码,点击会找不到文件。思源已回滚为
// 使用原始路径(中文/空格/全角括号原样保留)——这是思源能点击打开的唯一可靠格式。
// 因此这里只把反斜杠转正斜杠、补齐 file:// 前缀,不做任何 percent-编码。
// 含 ASCII 空格或 ) 的路径在 markdown 链接里需用 <...> 包裹(toMarkdownLink 负责)。
export function toFileUrl(absPath: string): string {
    if (!absPath) return "";
    const norm = absPath.replace(/\\/g, "/");
    // UNC 路径(\\server\share\...):server 作为 URL authority,file://server/share/x
    if (/^\/\//.test(norm)) {
        return "file://" + norm.replace(/^\/+/, "");
    }
    // POSIX 绝对路径 /home/... 与 Windows 盘符 E:/... 都用空 authority 形式
    return "file:///" + norm.replace(/^\/+/, "");
}

// 将 file:// 链接还原为系统绝对路径(与 toFileUrl 互逆)
// 处理 Windows 盘符(file:///E:/... → E:/...)、POSIX(file:///home → /home)、
// UNC(file://server/share/x → \\server\share\x)。percent-编码会被还原,原始路径基本 no-op。
// 非 file:// 协议或无法解析为绝对路径时返回 null。
export function fileUrlToPath(url: string): string | null {
    if (!url || !/^file:\/\//i.test(url)) return null;
    // 取出 file:// 之后(含斜杠)的部分,再 percent-解码
    let rest = url.slice(url.indexOf("//") + 2);
    try {
        rest = decodeURIComponent(rest);
    } catch {
        // 已是普通文本,保持原样
    }
    // UNC:file://server/share/x → 主机在 authority 位置,无盘符冒号
    const unc = rest.match(/^([^/]+)(\/.*)$/);
    if (unc && !/^[A-Za-z]:/i.test(unc[1])) {
        return "\\\\" + unc[1] + unc[2].replace(/\//g, "\\");
    }
    // 普通:file:///E:/HOME → E:/HOME ; file:///home → /home
    rest = rest.replace(/^\/+/, "");
    if (/^[A-Za-z]:[\\/]/.test(rest) || rest.startsWith("/") || rest.startsWith("\\\\")) return rest;
    return null;
}

// 将插件内部路径(思源虚拟路径或系统绝对路径)转换为原始 file:// 链接
// 思源路径先借工作空间目录还原为系统绝对路径;拿不到工作空间时返回 null
export function toFileLink(path: string): string | null {
    if (isSiyuanPath(path)) {
        const ws = getWorkspacePath();
        if (!ws) return null;
        return toFileUrl(toSystemPath(path, ws));
    }
    return toFileUrl(path);
}

// 判断 file:// 链接是否需要在 markdown 中用 <...> 包裹
// 原始路径含 ASCII 空格或 ) ] < > 时会破坏 markdown 链接 (url) 段,需用尖括号包裹
// (kramdown/CommonMark 标准,<...> 内允许空格与特殊字符,渲染时去掉尖括号)
function needsAngleBracket(url: string): boolean {
    return /[ )\]<>]/.test(url);
}

// 生成 markdown 格式链接:[label](url) 或 [label](<url>)
// label 取 basename,转义 [ ] \;url 用原始 file:// 链接(思源可点击打开)
export function toMarkdownFileLink(path: string): {label: string; url: string; md: string} | null {
    const url = toFileLink(path);
    if (!url) return null;
    const safeLabel = basename(path).replace(/[[\]\\]/g, "\\$1");
    const md = needsAngleBracket(url)
        ? `[${safeLabel}](<${url}>)`
        : `[${safeLabel}](${url})`;
    return {label: safeLabel, url, md};
}
