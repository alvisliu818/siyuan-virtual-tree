// 无 TypeScript 类型定义的第三方模块(ambient 声明,导入结果按 any 处理)
//
// 注意:
// - x-data-spreadsheet 的 dist 产物是**无 UMD 包装**的 webpack 包,只把类挂到
//   window.x_spreadsheet,模块本身没有可用导出。因此必须 import 执行后从 window 取。
// - mammoth 用 mammoth.browser.js(自带依赖的浏览器构建),避免 webpack 5 解析
//   node 的 fs/path 导致报错。
declare module "x-data-spreadsheet/dist/xspreadsheet.js";

declare module "mammoth/mammoth.browser.js";
