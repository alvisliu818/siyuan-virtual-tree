// Outlook 邮箱虚拟路径(纯语法层,无 IO;数据依赖配置,见 api/outlook-mail.ts)
//
// 虚拟路径格式(与 bdpan://、onedrive:// 等远程方案一致):
//   outlook:///                 根 = 邮件文件夹列表(Inbox、Sent Items、Drafts…)
//   outlook:///Inbox            收件箱下的邮件文件列表
//   outlook:///Inbox/<邮件>.md  单封邮件(只读;正文转 Markdown + 附件清单)
//   outlook:///Inbox/<邮件>.files/<附件名>  邮件附件(懒下载)
// 邮件本身不可编辑:writeFile/mkdir/rename/remove 一律拒绝。
export const OUTLOOK_PREFIX = "outlook://";

// 是否 Outlook 邮箱虚拟路径
export function isOutlookPath(p: string): boolean {
    return typeof p === "string" && p.startsWith(OUTLOOK_PREFIX);
}

// 取虚拟路径去掉前缀并去掉结尾斜杠后的内部路径:"outlook:///Inbox/" → "/Inbox";"outlook://" → ""
export function outlookPathBody(vPath: string): string {
    return vPath.slice(OUTLOOK_PREFIX.length).replace(/\/+$/, "");
}

// 拼接虚拟子路径
export function outlookChildVPath(vBase: string, name: string): string {
    return vBase + "/" + name;
}

// 挂载根的显示名
export function outlookRootLabel(vPath: string): string {
    return "[Outlook 邮箱]";
}
