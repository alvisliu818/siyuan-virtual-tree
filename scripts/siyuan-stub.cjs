/**
 * 测试用的 siyuan 运行时 stub。
 *
 * jsdom 集成测试不需要真实思源运行时（Plugin / Setting / fetchPost）
 * 只需要这些名字能被解析，模块才能加载。所有实现都是 no-op。
 */
class Plugin {
    constructor() {}
    addCommand() {}
    addIcons() {}
    onload() {}
    onunload() {}
    saveData() {}
    loadData() {}
}

class Setting {
    constructor() {}
    addItem() {}
}

function fetchPost() {
    return Promise.resolve({ code: 0, data: null });
}

function showMessage() {}
function confirmDialog() {}
class Protyle {}

module.exports = {
    Plugin,
    Setting,
    fetchPost,
    showMessage,
    confirmDialog,
    Protyle,
};
