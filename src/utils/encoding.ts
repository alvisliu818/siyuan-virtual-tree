// 文本编码自动检测解码:严格 UTF-8 优先,失败回退 GBK
// 思源工作空间内文件多为 UTF-8;Windows 下部分工具(老版记事本、
// 网上下载的课程资料等)生成的文本文件为 GBK,直接按 UTF-8 解码会乱码。
// TextDecoder("gbk") 实际按 GB18030(GBK 超集)解码,Chromium/Electron 原生支持。

let utf8Decoder: TextDecoder | null = null;
let gbkDecoder: TextDecoder | null = null;

export function decodeAuto(bytes: Uint8Array): string {
    if (bytes.length === 0) return "";
    if (!utf8Decoder) utf8Decoder = new TextDecoder("utf-8", {fatal: true});
    try {
        // 默认 ignoreBOM=false,输出自动去掉 UTF-8 BOM
        return utf8Decoder.decode(bytes);
    } catch {
        // 含非法 UTF-8 序列,回退按 GBK 解码
    }
    if (!gbkDecoder) gbkDecoder = new TextDecoder("gbk");
    return gbkDecoder.decode(bytes);
}
