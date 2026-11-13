// IMAP 邮箱虚拟路径(纯语法层,无 IO;连接与数据见 api/imap-mail.ts)
//
// 虚拟路径格式:
//   imap://<provider>/                      根 = 邮件文件夹列表(INBOX、Sent Messages…)
//   imap://<provider>/<encMailbox>/         该邮箱夹的邮件列表
//   imap://<provider>/<encMailbox>/<邮件>.md  单封邮件(只读;正文转 Markdown + 附件清单)
//   imap://<provider>/<encMailbox>/<邮件>.files/<附件名>  附件(懒下载)
// provider ∈ qq | 163 | 126(服务器映射见 api/imap-mail.ts)。
// 路径段(邮箱夹名/文件名)整体 encodeURIComponent,解码在 imap-mail.ts 侧完成。
// 邮箱挂载为只读源;桌面端专用(移动端 webview 无 TCP 能力,操作报可读错误)。
export const IMAP_PREFIX = "imap://";

// 是否 IMAP 邮箱虚拟路径
export function isImapPath(p: string): boolean {
    return typeof p === "string" && p.startsWith(IMAP_PREFIX);
}

// 拆解:provider 与剩余路径段数组(已解码);根返回 {provider, segs: []}
export function imapPathParts(vPath: string): {provider: string; segs: string[]} {
    const rest = vPath.slice(IMAP_PREFIX.length).replace(/^\/+/, "").replace(/\/+$/, "");
    if (!rest) return {provider: "", segs: []};
    const rawSegs = rest.split("/").filter(Boolean);
    const segs = rawSegs.map(s => {
        try {
            return decodeURIComponent(s);
        } catch {
            return s;
        }
    });
    return {provider: segs[0] || "", segs: segs.slice(1)};
}

// 拼接:provider 根
export function imapProviderRoot(provider: string): string {
    return IMAP_PREFIX + provider + "/";
}

// 拼接:provider 下追加一段(各段 encodeURIComponent)
export function imapChildVPath(vBase: string, seg: string): string {
    return vBase + "/" + encodeURIComponent(seg);
}

// 挂载根的显示名(纯字符串,不触发网络)
export function imapRootLabel(provider: string): string {
    const names: Record<string, string> = {qq: "QQ 邮箱", "163": "网易 163", "126": "网易 126"};
    return "[IMAP] " + (names[provider] || provider);
}
