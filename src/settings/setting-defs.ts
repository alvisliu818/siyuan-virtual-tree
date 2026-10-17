// 设置项注册表:一份定义同时喂给三个消费方
//   1. 设置面板里的「代码编辑器」分组(GUI)
//   2. settings.json —— VS Code 风格的用户设置文件(键名与 VS Code 对齐)
//   3. Monaco 编辑器选项(createEditor 建实例 / updateOptions 即时生效)
//
// 为什么是"注册表"而不是三处各写一遍:三者必须完全一致,否则会出现"面板里改了没效果"
// 或"settings.json 里的键面板不认"这类最难排查的问题。新增一项只改这里。
//
// 优先级:settings.json > 插件 config.json。config.json 里的同义字段由
// user-settings 的 applyUserSettingsToConfig 按此表回写,保证老代码读 plugin.config 依然正确。
import {EditorConfig} from "../types";

export type SettingKind = "boolean" | "number" | "string" | "enum" | "numberArray";

export interface SettingDef {
    /** VS Code 风格点分键名,如 editor.wordWrap */
    key: string;
    kind: SettingKind;
    /** 分组名(GUI 里按组分块) */
    group: string;
    /** 中文标题 */
    title: string;
    /** 说明:同时用于 GUI 描述与 settings.json 的悬停提示 */
    description: string;
    default: any;
    /** 枚举取值(kind=enum 必填) */
    enum?: string[];
    /** 枚举值的中文标签 */
    enumLabels?: Record<string, string>;
    min?: number;
    max?: number;
    placeholder?: string;
    /** 值 → 写入 Monaco 的值(用于 VS Code 与 Monaco 命名不一致的项) */
    toMonaco?: (v: any) => any;
    /** Monaco 里的键路径;默认取去掉 "editor." 前缀后的点分路径(自动嵌套) */
    monacoKey?: string;
    /** true = 不写入 Monaco(本项目自己实现的编辑器行为) */
    skipMonaco?: boolean;
    /** 插件自有设置:从配置读 */
    get?: (cfg: EditorConfig) => any;
    /** 插件自有设置:写入配置 */
    set?: (cfg: EditorConfig, v: any) => void;
}

// ============ 代码编辑器设置(键名与 VS Code 一致) ============

const G_FONT = "字体";
const G_WRAP = "换行";
const G_INDENT = "缩进与空白";
const G_CURSOR = "光标";
const G_GUIDE = "行号与参考线";
const G_FOLD = "折叠与粘滞滚动";
const G_SCROLL = "导航窗格与滚动";
const G_EDIT = "编辑辅助";
const G_SUGGEST = "建议与悬停";
const G_LOOK = "外观细节";

const STRATEGY = ["always", "languageDefined", "beforeWhitespace", "never"];
const STRATEGY_LABELS: Record<string, string> = {
    always: "总是",
    languageDefined: "按语言配置",
    beforeWhitespace: "仅空白前",
    never: "从不",
};

export const EDITOR_DEFS: SettingDef[] = [
    // ---- 字体 ----
    {
        key: "editor.fontSize",
        kind: "number",
        group: G_FONT,
        title: "字体大小",
        description: "编辑器字号(px)",
        default: 14,
        min: 8,
        max: 32,
    },
    {
        key: "editor.fontFamily",
        kind: "string",
        group: G_FONT,
        title: "字体族",
        description: "如 Consolas, 'Courier New', monospace;留空使用默认等宽字体",
        default: "",
        placeholder: "Consolas, 'Courier New', monospace",
    },
    {
        key: "editor.fontLigatures",
        kind: "boolean",
        group: G_FONT,
        title: "字体连字",
        description: "启用连字(需要字体本身支持,如 Fira Code)",
        default: false,
    },
    {
        key: "editor.lineHeight",
        kind: "number",
        group: G_FONT,
        title: "行高",
        description: "0 = 自动(按字号计算);否则为像素行高",
        default: 0,
        min: 0,
        max: 64,
    },
    {
        key: "editor.letterSpacing",
        kind: "number",
        group: G_FONT,
        title: "字间距",
        description: "额外的字间距(px),可为负",
        default: 0,
        min: -5,
        max: 20,
    },

    // ---- 换行(本次重点) ----
    {
        key: "editor.wordWrap",
        kind: "enum",
        group: G_WRAP,
        title: "自动换行",
        description: "off = 不换行(横向滚动);on = 按视口宽度换行;column = 按「换行列」换行;bounded = 取视口宽度与换行列的较小值",
        default: "off",
        enum: ["off", "on", "column", "bounded"],
        enumLabels: {off: "关闭", on: "按视口宽度", column: "按指定列", bounded: "取较小值(bounded)"},
        // VS Code 用 "column",Monaco 用 "wordWrapColumn"
        toMonaco: (v) => (v === "column" ? "wordWrapColumn" : v),
    },
    {
        key: "editor.wordWrapColumn",
        kind: "number",
        group: G_WRAP,
        title: "换行列",
        description: "自动换行为「按指定列」或「取较小值」时,按此列换行",
        default: 80,
        min: 20,
        max: 500,
    },
    {
        key: "editor.wrappingIndent",
        kind: "enum",
        group: G_WRAP,
        title: "换行缩进",
        description: "换行后 continuation 行的缩进方式",
        default: "same",
        enum: ["none", "same", "indent", "deepIndent"],
        enumLabels: {none: "不缩进", same: "与首行对齐", indent: "缩进一级", deepIndent: "缩进两级"},
    },
    {
        key: "editor.wrappingStrategy",
        kind: "enum",
        group: G_WRAP,
        title: "换行策略",
        description: "advanced 对中文/等宽字符的断行更合理,代价是长行渲染更慢",
        default: "simple",
        enum: ["simple", "advanced"],
        enumLabels: {simple: "简单(快)", advanced: "高级(慢)"},
    },

    // ---- 缩进与空白 ----
    {
        key: "editor.tabSize",
        kind: "number",
        group: G_INDENT,
        title: "Tab 宽度",
        description: "一个制表符等于几个空格",
        default: 4,
        min: 1,
        max: 16,
    },
    {
        key: "editor.insertSpaces",
        kind: "boolean",
        group: G_INDENT,
        title: "用空格缩进",
        description: "按 Tab 时插入空格而非制表符",
        default: true,
    },
    {
        key: "editor.detectIndentation",
        kind: "boolean",
        group: G_INDENT,
        title: "自动检测缩进",
        description: "打开文件时按文件内容推断缩进(会覆盖 Tab 宽度与「用空格缩进」)",
        default: true,
    },
    {
        key: "editor.autoIndent",
        kind: "enum",
        group: G_INDENT,
        title: "自动缩进",
        description: "回车、粘贴、输入时自动缩进的策略",
        default: "full",
        enum: ["none", "keep", "brackets", "advanced", "full"],
        enumLabels: {none: "不缩进", keep: "保持", brackets: "按括号", advanced: "高级", full: "完整"},
    },
    {
        key: "editor.renderWhitespace",
        kind: "enum",
        group: G_INDENT,
        title: "显示空白字符",
        description: "何时渲染空格与制表符的可见标记",
        default: "selection",
        enum: ["none", "boundary", "selection", "trailing", "all"],
        enumLabels: {none: "从不", boundary: "词间空白", selection: "仅选中区", trailing: "仅行尾", all: "总是"},
    },
    {
        key: "editor.renderControlCharacters",
        kind: "boolean",
        group: G_INDENT,
        title: "显示控制字符",
        description: "渲染控制字符(如 \\u0000)的可见标记",
        default: false,
    },
    {
        key: "editor.trimAutoWhitespace",
        kind: "boolean",
        group: G_INDENT,
        title: "清除自动缩进空白",
        description: "删除自动缩进插入到空行上的空白",
        default: true,
    },
    {
        key: "editor.renderFinalNewline",
        kind: "enum",
        group: G_INDENT,
        title: "文件末尾换行",
        description: "文件不以换行结尾时如何显示最后一行",
        default: "off",
        enum: ["off", "on", "dimmed"],
        enumLabels: {off: "关", on: "开", dimmed: "淡化显示"},
    },
    {
        key: "editor.rulers",
        kind: "numberArray",
        group: G_INDENT,
        title: "标尺列",
        description: "在这些列绘制竖参考线,逗号分隔,如 80,120",
        default: [],
        placeholder: "80,120",
    },

    // ---- 光标 ----
    {
        key: "editor.cursorStyle",
        kind: "enum",
        group: G_CURSOR,
        title: "光标样式",
        description: "光标的形状",
        default: "line",
        enum: ["line", "block", "underline", "line-thin", "block-outline", "underline-thin"],
        enumLabels: {
            line: "竖线", block: "方块", underline: "下划线",
            "line-thin": "细竖线", "block-outline": "方块描边", "underline-thin": "细下划线",
        },
    },
    {
        key: "editor.cursorBlinking",
        kind: "enum",
        group: G_CURSOR,
        title: "光标闪烁",
        description: "光标的闪烁动画",
        default: "smooth",
        enum: ["blink", "smooth", "phase", "expand", "solid"],
        enumLabels: {blink: "闪烁", smooth: "平滑", phase: "渐变", expand: "扩张", solid: "不闪烁"},
    },
    {
        key: "editor.cursorSmoothCaretAnimation",
        kind: "enum",
        group: G_CURSOR,
        title: "光标平滑移动",
        description: "光标移动时是否有动画",
        default: "off",
        enum: ["off", "explicit", "on"],
        enumLabels: {off: "关", explicit: "仅显式移动", on: "开"},
    },
    {
        key: "editor.cursorSurroundingLines",
        kind: "number",
        group: G_CURSOR,
        title: "光标上下保留行",
        description: "滚动时光标上下至少保留的行数(0 = 不保留)",
        default: 0,
        min: 0,
        max: 20,
    },
    {
        key: "editor.columnSelection",
        kind: "boolean",
        group: G_CURSOR,
        title: "列选择",
        description: "启用列(矩形)选择:Alt + 拖拽",
        default: false,
    },
    {
        key: "editor.roundedSelection",
        kind: "boolean",
        group: G_CURSOR,
        title: "圆角选区",
        description: "选区四角使用圆角",
        default: true,
    },

    // ---- 行号与参考线 ----
    {
        key: "editor.lineNumbers",
        kind: "enum",
        group: G_GUIDE,
        title: "行号",
        description: "行号的显示方式",
        default: "on",
        enum: ["on", "off", "relative", "interval"],
        enumLabels: {on: "显示", off: "隐藏", relative: "相对行号", interval: "每隔 10 行"},
    },
    {
        key: "editor.guides.indentation",
        kind: "boolean",
        group: G_GUIDE,
        title: "缩进参考线",
        description: "显示缩进层级的竖线",
        default: true,
    },
    {
        key: "editor.guides.bracketPairs",
        kind: "enum",
        group: G_GUIDE,
        title: "括号对参考线",
        description: "是否绘制括号对的竖直参考线;active = 只在光标位于该括号对时显示",
        default: "active",
        enum: ["active", "true", "false"],
        enumLabels: {active: "仅光标所在处", true: "总是", false: "从不"},
        toMonaco: (v) => (v === "true" ? true : v === "false" ? false : v),
    },
    {
        key: "editor.guides.highlightActiveIndentation",
        kind: "enum",
        group: G_GUIDE,
        title: "高亮当前缩进线",
        description: "高亮光标所在的缩进参考线",
        default: "true",
        enum: ["always", "true", "false"],
        enumLabels: {always: "总是高亮", true: "光标在行内时", false: "不高亮"},
        toMonaco: (v) => (v === "true" ? true : v === "false" ? false : v),
    },
    {
        key: "editor.bracketPairColorization.enabled",
        kind: "boolean",
        group: G_GUIDE,
        title: "括号对着色",
        description: "给配对的括号按层级上色",
        default: true,
    },
    {
        key: "editor.matchBrackets",
        kind: "enum",
        group: G_GUIDE,
        title: "括号匹配高亮",
        description: "光标靠近括号时高亮其配对括号",
        default: "always",
        enum: ["always", "near", "never"],
        enumLabels: {always: "总是", near: "相邻时", never: "从不"},
    },
    {
        key: "editor.renderLineHighlight",
        kind: "enum",
        group: G_GUIDE,
        title: "当前行高亮",
        description: "高亮光标所在行的方式",
        default: "line",
        enum: ["none", "gutter", "line", "all"],
        enumLabels: {none: "不高亮", gutter: "仅行号槽", line: "整行", all: "整行 + 行号槽"},
    },
    {
        key: "editor.occurrencesHighlight",
        kind: "enum",
        group: G_GUIDE,
        title: "相同词高亮",
        description: "选中词时高亮文档中的其它出现位置",
        default: "singleFile",
        enum: ["off", "singleFile", "multiFile"],
        enumLabels: {off: "关", singleFile: "当前文件", multiFile: "所有打开的文件"},
    },

    // ---- 折叠与粘滞滚动 ----
    {
        key: "editor.folding",
        kind: "boolean",
        group: G_FOLD,
        title: "代码折叠",
        description: "启用代码块的折叠/展开",
        default: true,
    },
    {
        key: "editor.showFoldingControls",
        kind: "enum",
        group: G_FOLD,
        title: "折叠箭头",
        description: "折叠箭头的显示时机",
        default: "mouseover",
        enum: ["always", "mouseover", "never"],
        enumLabels: {always: "总是", mouseover: "鼠标悬停时", never: "从不"},
    },
    {
        key: "editor.foldingHighlight",
        kind: "boolean",
        group: G_FOLD,
        title: "高亮折叠区",
        description: "高亮光标所在的折叠区域",
        default: true,
    },
    {
        key: "editor.stickyScroll.enabled",
        kind: "boolean",
        group: G_FOLD,
        title: "粘滞滚动",
        description: "滚动时在编辑器顶部粘住当前所在的作用域(如函数头)",
        default: false,
    },
    {
        key: "editor.stickyScroll.maxLineCount",
        kind: "number",
        group: G_FOLD,
        title: "粘滞最大行数",
        description: "粘滞区最多显示多少行",
        default: 5,
        min: 1,
        max: 20,
    },

    // ---- 导航窗格与滚动 ----
    {
        key: "editor.minimap.enabled",
        kind: "boolean",
        group: G_SCROLL,
        title: "导航窗格(minimap)",
        description: "编辑器右侧的缩略导航图;关闭后编辑区变宽,适合窄屏",
        default: true,
    },
    {
        key: "editor.minimap.side",
        kind: "enum",
        group: G_SCROLL,
        title: "导航窗格位置",
        description: "缩略图显示在编辑区的哪一侧",
        default: "right",
        enum: ["right", "left"],
        enumLabels: {right: "右侧", left: "左侧"},
    },
    {
        key: "editor.minimap.showSlider",
        kind: "enum",
        group: G_SCROLL,
        title: "导航窗格滑块",
        description: "缩略图滑块的显示时机",
        default: "mouseover",
        enum: ["always", "mouseover"],
        enumLabels: {always: "总是", mouseover: "鼠标悬停时"},
    },
    {
        key: "editor.minimap.renderCharacters",
        kind: "boolean",
        group: G_SCROLL,
        title: "导航窗格显示字符",
        description: "在缩略图里渲染真实字符;关闭则只用色块(更快)",
        default: true,
    },
    {
        key: "editor.minimap.maxColumn",
        kind: "number",
        group: G_SCROLL,
        title: "导航窗格最大列",
        description: "缩略图最多渲染到多少列",
        default: 120,
        min: 40,
        max: 1000,
    },
    {
        key: "editor.scrollBeyondLastLine",
        kind: "boolean",
        group: G_SCROLL,
        title: "可越过最后一行滚动",
        description: "允许继续向下滚动,使最后一行不必贴着编辑器底边",
        default: true,
    },
    {
        key: "editor.smoothScrolling",
        kind: "boolean",
        group: G_SCROLL,
        title: "平滑滚动",
        description: "滚动与光标移动使用动画过渡",
        default: true,
    },
    {
        key: "editor.mouseWheelZoom",
        kind: "boolean",
        group: G_SCROLL,
        title: "Ctrl + 滚轮缩放",
        description: "按住 Ctrl 滚动滚轮时缩放编辑器字号",
        default: false,
    },
    {
        key: "editor.scrollbar.vertical",
        kind: "enum",
        group: G_SCROLL,
        title: "垂直滚动条",
        description: "垂直滚动条的显示策略",
        default: "auto",
        enum: ["auto", "visible", "hidden"],
        enumLabels: {auto: "自动", visible: "总是显示", hidden: "隐藏"},
    },
    {
        key: "editor.scrollbar.horizontal",
        kind: "enum",
        group: G_SCROLL,
        title: "水平滚动条",
        description: "水平滚动条的显示策略",
        default: "auto",
        enum: ["auto", "visible", "hidden"],
        enumLabels: {auto: "自动", visible: "总是显示", hidden: "隐藏"},
    },
    {
        key: "editor.scrollbar.verticalScrollbarSize",
        kind: "number",
        group: G_SCROLL,
        title: "垂直滚动条宽度",
        description: "垂直滚动条的宽度(px)",
        default: 14,
        min: 8,
        max: 30,
    },
    {
        key: "editor.scrollbar.horizontalScrollbarSize",
        kind: "number",
        group: G_SCROLL,
        title: "水平滚动条高度",
        description: "水平滚动条的高度(px)",
        default: 14,
        min: 8,
        max: 30,
    },
    {
        key: "editor.scrollbar.useShadows",
        kind: "boolean",
        group: G_SCROLL,
        title: "滚动条阴影",
        description: "滚动到边缘时显示阴影提示还有内容",
        default: true,
    },

    // ---- 编辑辅助 ----
    {
        key: "editor.autoClosingBrackets",
        kind: "enum",
        group: G_EDIT,
        title: "自动闭合括号",
        description: "输入左括号时自动补上右括号",
        default: "languageDefined",
        enum: STRATEGY,
        enumLabels: STRATEGY_LABELS,
    },
    {
        key: "editor.autoClosingQuotes",
        kind: "enum",
        group: G_EDIT,
        title: "自动闭合引号",
        description: "输入引号时自动补上配对的引号",
        default: "languageDefined",
        enum: STRATEGY,
        enumLabels: STRATEGY_LABELS,
    },
    {
        key: "editor.autoSurround",
        kind: "enum",
        group: G_EDIT,
        title: "自动包围选中内容",
        description: "选中内容后输入引号/括号时,自动包围选区而非替换",
        default: "languageDefined",
        enum: ["languageDefined", "quotes", "brackets", "never"],
        enumLabels: {languageDefined: "按语言配置", quotes: "仅引号", brackets: "仅括号", never: "从不"},
    },
    {
        key: "editor.formatOnType",
        kind: "boolean",
        group: G_EDIT,
        title: "输入时格式化",
        description: "输入分号/换行等触发字符时格式化当前行(需要该语言有格式化器)",
        default: false,
    },
    {
        key: "editor.formatOnPaste",
        kind: "boolean",
        group: G_EDIT,
        title: "粘贴时格式化",
        description: "粘贴的内容自动格式化(需要该语言有格式化器)",
        default: false,
    },
    {
        key: "editor.formatOnSave",
        kind: "boolean",
        group: G_EDIT,
        title: "保存时格式化",
        description: "Ctrl+S 保存前先格式化整个文档(需要该语言有格式化器,如 JSON/HTML/CSS/TS)",
        default: false,
        // 本插件在保存流程里自己实现,Monaco 没有同名选项
        skipMonaco: true,
    },
    {
        key: "editor.links",
        kind: "boolean",
        group: G_EDIT,
        title: "可点击链接",
        description: "检测编辑器里的链接并允许点击打开",
        default: true,
    },
    {
        key: "editor.codeLens",
        kind: "boolean",
        group: G_EDIT,
        title: "CodeLens",
        description: "显示语言服务提供的 CodeLens 提示(如引用数)",
        default: false,
    },
    {
        key: "editor.largeFileOptimizations",
        kind: "boolean",
        group: G_EDIT,
        title: "大文件优化",
        description: "打开大文件时关闭部分耗内存的特性(会牺牲一些高亮精度)",
        default: true,
    },

    // ---- 建议与悬停 ----
    {
        key: "editor.quickSuggestions",
        kind: "boolean",
        group: G_SUGGEST,
        title: "输入时自动建议",
        description: "边输入边弹出补全建议;关闭后仍可用 Ctrl+Space 手动触发",
        default: true,
    },
    {
        key: "editor.acceptSuggestionOnEnter",
        kind: "enum",
        group: G_SUGGEST,
        title: "回车接受建议",
        description: "on = 回车接受建议;smart = 仅当建议会改变文本时才接受;off = 回车只换行",
        default: "on",
        enum: ["on", "smart", "off"],
        enumLabels: {on: "开", smart: "智能", off: "关"},
    },
    {
        key: "editor.tabCompletion",
        kind: "enum",
        group: G_SUGGEST,
        title: "Tab 补全",
        description: "按 Tab 时插入当前建议",
        default: "off",
        enum: ["on", "off", "onlySnippets"],
        enumLabels: {on: "开", off: "关", onlySnippets: "仅代码片段"},
    },
    {
        key: "editor.wordBasedSuggestions",
        kind: "enum",
        group: G_SUGGEST,
        title: "基于词的建议",
        description: "用文档里的词生成补全建议的覆盖范围",
        default: "matchingDocuments",
        enum: ["off", "currentDocument", "matchingDocuments", "allDocuments"],
        enumLabels: {off: "关", currentDocument: "当前文档", matchingDocuments: "同类文档", allDocuments: "所有文档"},
    },
    {
        key: "editor.inlineSuggest.enabled",
        kind: "boolean",
        group: G_SUGGEST,
        title: "行内建议",
        description: "显示灰色的行内补全提示",
        default: true,
    },
    {
        key: "editor.hover.enabled",
        kind: "boolean",
        group: G_SUGGEST,
        title: "悬停提示",
        description: "鼠标悬停时显示类型/文档提示",
        default: true,
    },
    {
        key: "editor.hover.delay",
        kind: "number",
        group: G_SUGGEST,
        title: "悬停延迟",
        description: "悬停多久后弹出提示(ms)",
        default: 300,
        min: 0,
        max: 2000,
    },

    // ---- 外观细节 ----
    {
        key: "editor.padding.top",
        kind: "number",
        group: G_LOOK,
        title: "顶部留白",
        description: "编辑区顶部到第一行的间距(px)",
        default: 8,
        min: 0,
        max: 100,
    },
    {
        key: "editor.padding.bottom",
        kind: "number",
        group: G_LOOK,
        title: "底部留白",
        description: "最后一行到编辑区底部的间距(px)",
        default: 24,
        min: 0,
        max: 200,
    },
    {
        key: "editor.overviewRulerLanes",
        kind: "number",
        group: G_LOOK,
        title: "概览标尺列数",
        description: "右侧概览标尺可以并排显示几条标记(0 = 隐藏)",
        default: 3,
        min: 0,
        max: 5,
    },
    {
        key: "editor.overviewRulerBorder",
        kind: "boolean",
        group: G_LOOK,
        title: "概览标尺边框",
        description: "在概览标尺左侧画一条分隔线",
        default: true,
    },
    {
        key: "editor.hideCursorInOverviewRuler",
        kind: "boolean",
        group: G_LOOK,
        title: "概览标尺隐藏光标",
        description: "不在概览标尺上标出光标位置",
        default: false,
    },
    {
        key: "editor.fixedOverflowWidgets",
        kind: "boolean",
        group: G_LOOK,
        title: "固定悬浮部件",
        description: "建议/悬停等浮层不随编辑区裁剪,允许溢出到编辑器外",
        default: false,
    },
];

// ============ 插件自有设置(settings.json 里同样可写) ============
// 只登记"有明确含义、用户可能想用 JSON 覆盖"的项;面板里改完会同步回写到这里,
// 反过来在这里改完保存也会立即覆盖面板值(见 user-settings 的双向同步)。

const G_FILES = "文件";
const G_MD = "Markdown";
const G_TERM = "终端";
const G_WORKBENCH = "工作台";
const G_TREE = "虚拟文档树";

export const PLUGIN_DEFS: SettingDef[] = [
    {
        key: "files.fileTreeRoot",
        kind: "string",
        group: G_FILES,
        title: "文件树根目录",
        description: "文件管理器默认打开的目录;思源工作空间内填 /data,工作空间外填系统绝对路径",
        default: "/data",
        get: (c) => c.fileTreeRoot,
        set: (c, v) => { c.fileTreeRoot = String(v ?? "").trim() || "/data"; },
    },
    {
        key: "files.searchMaxFileSize",
        kind: "number",
        group: G_FILES,
        title: "搜索最大文件大小(KB)",
        description: "超过此大小的文件不参与全局搜索",
        default: 1024,
        min: 100,
        max: 10240,
        get: (c) => Math.round((c.searchMaxFileSize || 0) / 1024),
        set: (c, v) => { c.searchMaxFileSize = Math.max(1, Number(v) || 1024) * 1024; },
    },
    {
        key: "files.versionKeepCount",
        kind: "number",
        group: G_FILES,
        title: "版本控制保留数",
        description: "每次保存时把修改前的内容存为历史版本,保留多少条;0 = 关闭版本控制",
        default: 10,
        min: 0,
        max: 200,
        get: (c) => c.versionKeepCount,
        set: (c, v) => { c.versionKeepCount = Math.max(0, Number(v) || 0); },
    },
    {
        key: "files.deleteMode",
        kind: "enum",
        group: G_FILES,
        title: "删除方式",
        description: "删除时移入插件回收站(可一键恢复)还是系统回收站",
        default: "plugin",
        enum: ["plugin", "system"],
        enumLabels: {plugin: "插件回收站", system: "系统回收站"},
        get: (c) => c.deleteMode,
        set: (c, v) => { c.deleteMode = v === "system" ? "system" : "plugin"; },
    },
    {
        key: "files.closeUnsavedAction",
        kind: "enum",
        group: G_FILES,
        title: "关闭未保存标签页时",
        description: "关闭有未保存修改的页签时的行为",
        default: "ask",
        enum: ["ask", "discard", "save"],
        enumLabels: {ask: "每次询问", discard: "直接放弃", save: "直接保存"},
        get: (c) => c.closeUnsavedAction,
        set: (c, v) => {
            c.closeUnsavedAction = v === "discard" || v === "save" ? v : "ask";
        },
    },
    {
        key: "files.importMdSourceAsset",
        kind: "boolean",
        group: G_FILES,
        title: "导入 Markdown 插入源文件",
        description: "导入 .md 到思源后,把源文件作为资源插入文档顶部的引述块",
        default: false,
        get: (c) => c.importMdSourceAsset === true,
        set: (c, v) => { c.importMdSourceAsset = v === true; },
    },
    {
        key: "files.docOpenTakeover",
        kind: "enum",
        group: G_FILES,
        title: "接管文档内打开文件",
        description: "点击思源文档里的文件链接时改用本插件打开:off = 不接管;exts = 仅指定扩展名;all = 全部",
        default: "off",
        enum: ["off", "exts", "all"],
        enumLabels: {off: "不接管", exts: "指定扩展名", all: "全部接管"},
        get: (c) => c.docOpenTakeover,
        set: (c, v) => {
            c.docOpenTakeover = v === "exts" || v === "all" ? v : "off";
        },
    },
    {
        key: "files.docOpenTakeoverExts",
        kind: "string",
        group: G_FILES,
        title: "接管扩展名",
        description: "「指定扩展名」模式下生效,逗号分隔,如 md,txt,log",
        default: "md,txt",
        get: (c) => c.docOpenTakeoverExts,
        set: (c, v) => { c.docOpenTakeoverExts = String(v ?? "").trim() || "md,txt"; },
    },
    {
        key: "files.showFileTreeDock",
        kind: "boolean",
        group: G_FILES,
        title: "显示「文件」面板",
        description: "文件浏览能力已由「虚拟文档树」承接,默认关闭",
        default: false,
        get: (c) => c.showFileTreeDock === true,
        set: (c, v) => { c.showFileTreeDock = v === true; },
    },

    {
        key: "markdown.defaultMode",
        kind: "enum",
        group: G_MD,
        title: "Markdown 默认模式",
        description: "打开 .md 的默认模式;超过 512KB 的大文件始终以源码模式打开",
        default: "live",
        enum: ["live", "source", "reading"],
        enumLabels: {live: "实时预览", source: "源码", reading: "阅读"},
        get: (c) => c.markdownDefaultMode,
        set: (c, v) => {
            c.markdownDefaultMode = v === "source" || v === "reading" ? v : "live";
        },
    },
    {
        key: "markdown.globalReadingMode",
        kind: "boolean",
        group: G_MD,
        title: "全局阅读模式",
        description: "开启后所有 Markdown 默认以只读渲染打开,优先级高于默认模式",
        default: true,
        get: (c) => c.globalReadingMode !== false,
        set: (c, v) => { c.globalReadingMode = v !== false; },
    },

    {
        key: "terminal.backend",
        kind: "enum",
        group: G_TERM,
        title: "终端后端",
        description: "内置(开箱即用,不支持全屏交互程序)/ 外部服务(完整 PTY)/ 自动",
        default: "auto",
        enum: ["auto", "builtin", "server"],
        enumLabels: {auto: "自动", builtin: "内置", server: "外部服务"},
        get: (c) => c.terminalBackend,
        set: (c, v) => {
            c.terminalBackend = v === "builtin" || v === "server" ? v : "auto";
        },
    },
    {
        key: "terminal.shell",
        kind: "enum",
        group: G_TERM,
        title: "终端 Shell",
        description: "集成终端使用的 shell,需重开终端页签后生效",
        default: "auto",
        enum: ["auto", "pwsh", "powershell", "cmd"],
        enumLabels: {auto: "自动检测", pwsh: "PowerShell 7", powershell: "Windows PowerShell", cmd: "命令提示符"},
        get: (c) => c.terminalShell,
        set: (c, v) => { c.terminalShell = String(v || "auto"); },
    },
    {
        key: "terminal.serverUrl",
        kind: "string",
        group: G_TERM,
        title: "终端服务地址",
        description: "仅「外部服务」模式需要",
        default: "ws://127.0.0.1:9800",
        get: (c) => c.terminalServerUrl,
        set: (c, v) => { c.terminalServerUrl = String(v ?? "").trim() || "ws://127.0.0.1:9800"; },
    },
    {
        key: "terminal.workspacePath",
        kind: "string",
        group: G_TERM,
        title: "思源工作空间路径",
        description: "把终端工作目录从 /data/... 转换为系统路径时使用;留空自动检测",
        default: "",
        get: (c) => c.siyuanWorkspacePath,
        set: (c, v) => { c.siyuanWorkspacePath = String(v ?? "").trim(); },
    },

    {
        key: "workbench.colorTheme",
        kind: "string",
        group: G_WORKBENCH,
        title: "代码主题",
        description: "Monaco 配色主题名;空 = 自动(优先扩展主题),__siyuan__ = 思源配色",
        default: "",
        get: (c) => c.colorTheme,
        set: (c, v) => { c.colorTheme = String(v ?? ""); },
    },
    {
        key: "workbench.iconTheme",
        kind: "string",
        group: G_WORKBENCH,
        title: "图标主题",
        description: "文件树与页签的图标主题(扩展 id);空 = 自动,__none__ = 思源内置图标",
        default: "",
        get: (c) => c.iconTheme,
        set: (c, v) => { c.iconTheme = String(v ?? ""); },
    },
    {
        key: "workbench.newTabReplacePlus",
        kind: "boolean",
        group: G_WORKBENCH,
        title: "新标签页接管顶部「+」",
        description: "点击思源顶部「+」改为打开插件新标签页",
        default: true,
        get: (c) => c.newTabReplacePlus !== false,
        set: (c, v) => { c.newTabReplacePlus = v !== false; },
    },
    {
        key: "workbench.newTabShowPinned",
        kind: "boolean",
        group: G_WORKBENCH,
        title: "新标签页显示「固定」",
        description: "固定区钉在页顶,可在文件树右键添加",
        default: true,
        get: (c) => c.newTabShowPinned !== false,
        set: (c, v) => { c.newTabShowPinned = v !== false; },
    },
    {
        key: "workbench.newTabShowRecent",
        kind: "boolean",
        group: G_WORKBENCH,
        title: "新标签页显示「最近打开」",
        description: "展示最近打开的文件与思源文档",
        default: true,
        get: (c) => c.newTabShowRecent !== false,
        set: (c, v) => { c.newTabShowRecent = v !== false; },
    },
    {
        key: "workbench.newTabShowFavorites",
        kind: "boolean",
        group: G_WORKBENCH,
        title: "新标签页显示「收藏」",
        description: "展示收藏区,可在文件树右键添加",
        default: true,
        get: (c) => c.newTabShowFavorites !== false,
        set: (c, v) => { c.newTabShowFavorites = v !== false; },
    },

    {
        key: "virtualTree.takeoverSplitOpen",
        kind: "boolean",
        group: G_TREE,
        title: "接管打开用分栏",
        description: "在思源文档里点击链接被接管打开时,用右侧分栏打开(文档与文件同屏)",
        default: false,
        get: (c) => c.takeoverSplitOpen === true,
        set: (c, v) => { c.takeoverSplitOpen = v === true; },
    },
    {
        key: "virtualTree.relation.enabled",
        kind: "boolean",
        group: G_TREE,
        title: "引用关系树",
        description: "在「虚拟文档树」面板顶部显示按文档首块引用关系自动构建的树",
        default: false,
        get: (c) => c.mountTreeRelation?.enabled === true,
        set: (c, v) => { if (c.mountTreeRelation) c.mountTreeRelation.enabled = v === true; },
    },
    {
        key: "virtualTree.relation.sortMethod",
        kind: "enum",
        group: G_TREE,
        title: "关系树排序方式",
        description: "自动挂载行的回退排序;拖拽顺序优先",
        default: "name",
        enum: ["name", "weight"],
        enumLabels: {name: "按名称", weight: "按权重"},
        get: (c) => c.mountTreeRelation?.sortMethod || "name",
        set: (c, v) => { if (c.mountTreeRelation) c.mountTreeRelation.sortMethod = v === "weight" ? "weight" : "name"; },
    },
    {
        key: "virtualTree.relation.weightAttrName",
        kind: "string",
        group: G_TREE,
        title: "关系树权重属性名",
        description: "文档自定义属性中用于排序的权重字段名(仅「按权重排序」时生效)",
        default: "weight",
        get: (c) => c.mountTreeRelation?.weightAttrName || "weight",
        set: (c, v) => { if (c.mountTreeRelation) c.mountTreeRelation.weightAttrName = String(v ?? "").trim() || "weight"; },
    },
    {
        key: "virtualTree.relation.caseSensitive",
        kind: "boolean",
        group: G_TREE,
        title: "关系树排序区分大小写",
        description: "按名称排序时是否区分大小写",
        default: false,
        get: (c) => c.mountTreeRelation?.caseSensitive === true,
        set: (c, v) => { if (c.mountTreeRelation) c.mountTreeRelation.caseSensitive = v === true; },
    },
    {
        key: "virtualTree.relation.includePhysicalSubtree",
        kind: "boolean",
        group: G_TREE,
        title: "关系树包含物理子树",
        description: "思源原生层级里的物理子文档也作为关系树的子节点",
        default: false,
        get: (c) => c.mountTreeRelation?.includePhysicalSubtree === true,
        set: (c, v) => { if (c.mountTreeRelation) c.mountTreeRelation.includePhysicalSubtree = v === true; },
    },
    {
        key: "virtualTree.relation.maxDepth",
        kind: "number",
        group: G_TREE,
        title: "关系树最大递归深度",
        description: "构建子树时的最大层数,防止深层引用卡顿",
        default: 10,
        min: 1,
        max: 50,
        get: (c) => c.mountTreeRelation?.maxDepth ?? 10,
        set: (c, v) => { if (c.mountTreeRelation) c.mountTreeRelation.maxDepth = Math.max(1, Number(v) || 10); },
    },
    {
        key: "virtualTree.relation.maxNodes",
        kind: "number",
        group: G_TREE,
        title: "关系树最大节点数",
        description: "关系树最多显示多少个文档",
        default: 500,
        min: 10,
        max: 5000,
        get: (c) => c.mountTreeRelation?.maxNodes ?? 500,
        set: (c, v) => { if (c.mountTreeRelation) c.mountTreeRelation.maxNodes = Math.max(10, Number(v) || 500); },
    },
    {
        key: "virtualTree.relation.defaultExpandLevel",
        kind: "number",
        group: G_TREE,
        title: "关系树默认展开层级",
        description: "0 = 全部折叠,-1 = 全部展开,N = 展开前 N 层",
        default: -1,
        min: -1,
        max: 20,
        get: (c) => c.mountTreeRelation?.defaultExpandLevel ?? -1,
        set: (c, v) => { if (c.mountTreeRelation) c.mountTreeRelation.defaultExpandLevel = Number.isFinite(Number(v)) ? Number(v) : 0; },
    },
];

export const ALL_DEFS: SettingDef[] = [...EDITOR_DEFS, ...PLUGIN_DEFS];

const DEF_INDEX = new Map<string, SettingDef>(ALL_DEFS.map(d => [d.key, d]));

export function defByKey(key: string): SettingDef | undefined {
    return DEF_INDEX.get(key);
}

/** 分组顺序(GUI 与生成的 settings.json 都按此顺序) */
export const GROUP_ORDER: string[] = [
    G_FONT, G_WRAP, G_INDENT, G_CURSOR, G_GUIDE, G_FOLD, G_SCROLL, G_EDIT, G_SUGGEST, G_LOOK,
    G_FILES, G_MD, G_TERM, G_WORKBENCH, G_TREE,
];

/** Monaco 里的键路径;返回 null 表示这一项不进 Monaco 选项 */
export function monacoKeyOf(d: SettingDef): string | null {
    if (d.skipMonaco) return null;
    if (d.monacoKey) return d.monacoKey;
    if (d.key.startsWith("editor.")) return d.key.slice("editor.".length);
    return null;
}

/** 按点分路径写入嵌套对象(minimap.enabled → {minimap:{enabled}}) */
export function setNested(target: Record<string, any>, dotted: string, value: any): void {
    const parts = dotted.split(".");
    let cur: Record<string, any> = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
}

/** 把值规整成该设置项的类型(用户手写 JSON 时类型可能不对) */
export function normalizeValue(d: SettingDef, raw: unknown): any {
    switch (d.kind) {
        case "boolean":
            return raw === true || raw === "true";
        case "number": {
            const n = Number(raw);
            if (!Number.isFinite(n)) return d.default;
            let v = n;
            if (typeof d.min === "number") v = Math.max(d.min, v);
            if (typeof d.max === "number") v = Math.min(d.max, v);
            return v;
        }
        case "numberArray": {
            if (Array.isArray(raw)) {
                return raw.map(Number).filter(n => Number.isFinite(n));
            }
            return parseNumberList(String(raw ?? ""));
        }
        case "enum":
            return d.enum && d.enum.indexOf(String(raw)) >= 0 ? String(raw) : d.default;
        default:
            return typeof raw === "string" ? raw : String(raw ?? "");
    }
}

export function parseNumberList(text: string): number[] {
    return String(text || "")
        .split(/[,，\s]+/)
        .map(s => Number(s.trim()))
        .filter(n => Number.isFinite(n));
}

/** 构造 settings.json 的 JSON Schema(补全 / 校验 / 悬停说明) */
export function buildSettingsJsonSchema(): Record<string, any> {
    const properties: Record<string, any> = {};
    for (const d of ALL_DEFS) {
        const doc = `${d.title} —— ${d.description}`;
        let schema: Record<string, any>;
        switch (d.kind) {
            case "boolean":
                schema = {type: "boolean", default: d.default, description: doc, markdownDescription: doc};
                break;
            case "number":
                schema = {type: "number", default: d.default, description: doc, markdownDescription: doc};
                if (typeof d.min === "number") schema.minimum = d.min;
                if (typeof d.max === "number") schema.maximum = d.max;
                break;
            case "numberArray":
                schema = {
                    type: "array",
                    items: {type: "number"},
                    default: d.default,
                    description: doc,
                    markdownDescription: doc,
                };
                break;
            case "enum":
                schema = {
                    enum: d.enum,
                    default: d.default,
                    description: doc,
                    markdownDescription: doc,
                    enumDescriptions: (d.enum || []).map(v => d.enumLabels?.[v] || v),
                };
                break;
            default:
                schema = {type: "string", default: d.default, description: doc, markdownDescription: doc};
        }
        properties[d.key] = schema;
    }
    return {
        type: "object",
        title: "虚拟文档树 —— 用户设置",
        // 允许写本表之外的键(与 VS Code 一致:未知键不报错,只是不生效)
        additionalProperties: true,
        properties,
    };
}
