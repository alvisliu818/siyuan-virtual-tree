// Office 编辑引擎的统一契约
// 各引擎(表格/文档/演示文稿/旧版兜底)都实现该接口,由 office-tab 统一挂载与调度。

// 引擎可向外暴露的额外工具栏按钮
export interface OfficeToolbarAction {
    label: string;
    // 内联 SVG 内容(可选),不提供则只显示文字
    svg?: string;
    onClick(): void;
}

export interface OfficeEngine {
    // 引擎渲染的 UI 根元素,由 Tab 挂到 DOM
    readonly root: HTMLElement;
    // 是否支持就地编辑(旧版二进制格式为 false,只能外部打开)
    readonly editable: boolean;
    // 是否存在未保存修改
    isDirty(): boolean;
    // 注册脏状态变化回调(用于 Tab 标题显示 ●)
    onDirtyChange(cb: (dirty: boolean) => void): void;
    // 保存到原文件
    save(): Promise<void>;
    // 销毁并释放资源
    dispose(): void;
    // 容器尺寸变化时回调(可选)
    resize?(): void;
    // 额外的工具栏按钮(可选)
    toolbarActions?: OfficeToolbarAction[];
}
