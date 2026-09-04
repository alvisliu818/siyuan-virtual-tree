// 思源虚拟路径与系统文件系统路径的相互转换

// 获取思源工作空间的绝对路径
export function getWorkspacePath(): string {
    const w = window as any;
    return w?.siyuan?.config?.system?.workspaceDir || "";
}

// 将思源虚拟路径(/data/...)转换为系统文件系统路径
// siyuanPath: 思源虚拟路径,如 /data/public/foo
// workspacePath: 思源工作空间系统路径,如 E:\HOME\SiYuan(可选,缺省时自动获取)
// 返回: 系统路径,如 E:\HOME\SiYuan\data\public\foo
export function toSystemPath(siyuanPath: string, workspacePath?: string): string {
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
