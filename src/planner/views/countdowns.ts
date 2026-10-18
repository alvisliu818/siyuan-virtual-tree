// 「倒数日」视图 + 卡片片段(今日视图也引用这里的卡片)。
// 年度重复的意义在于:生日这类节点不需要每年重设,面板自动把年份挪到最近一次。
import {ViewCtx} from "../context";
import {CountdownInfo, sortedCountdownInfos} from "../stats";
import {deleteCountdown, getData, reorderCountdown, updateCountdown} from "../store";
import {openCountdownDialog} from "../dialogs";
import {daysLabel, formatCNFull, todayKey} from "../dates";
import {emptyState, escapeHTML} from "../ui-common";
import {Countdown} from "../types";

export function renderCountdowns(ctx: ViewCtx): void {
    const {plugin, container} = ctx;
    const infos = sortedAll();
    container.innerHTML = `
        <div class="syfe-pl__toolbar">
            <button class="b3-button b3-button--text" id="syfe-pl-cd-new">+ 新建倒数日</button>
            <span class="fn__flex-1"></span>
            <span class="syfe-pl__small">今天 ${formatCNFull(todayKey())}</span>
        </div>
        ${infos.length
        ? `<div class="syfe-pl__cdgrid">${infos.map(i => countdownCardHTML(i)).join("")}</div>`
        : emptyState("还没有倒数日", "生日、纪念日、考试、项目节点都能记")}`;
    container.querySelector("#syfe-pl-cd-new")?.addEventListener("click", () => {
        openCountdownDialog(plugin, undefined, () => renderCountdowns(ctx));
    });
    container.querySelector(".syfe-pl__cdgrid")?.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const host = target.closest("[data-cd]") as HTMLElement | null;
        const id = host?.dataset.cd;
        if (!id) return;
        const cd = getData().countdowns.find(c => c.id === id);
        if (!cd) return;
        const act = target.dataset.act;
        const idx = infos.findIndex(i => i.cd.id === id);
        if (act === "edit") {
            openCountdownDialog(plugin, cd, () => renderCountdowns(ctx));
        } else if (act === "pin") {
            updateCountdown(plugin, id, {pinned: !cd.pinned});
            renderCountdowns(ctx);
        } else if (act === "delete") {
            deleteCountdown(plugin, id);
            renderCountdowns(ctx);
        } else if (act === "up") {
            reorderCountdown(plugin, id, idx - 1);
            renderCountdowns(ctx);
        } else if (act === "down") {
            reorderCountdown(plugin, id, idx + 1);
            renderCountdowns(ctx);
        } else {
            openCountdownDialog(plugin, cd, () => renderCountdowns(ctx));
        }
    });
}

function sortedAll(): CountdownInfo[] {
    // 复用 stats 里的排序(置顶优先 → 离今天近的优先)
    return sortedCountdownInfos();
}

/** 倒数日卡片(今日视图也用这一份,保证两个入口长得一样) */
export function countdownCardHTML(info: CountdownInfo): string {
    const cd = info.cd;
    const days = Math.abs(info.days);
    // until 类型若已经过去,语义上变成"已经过了 X 天";since 类型相反
    let head: string;
    if (cd.kind === "until") {
        head = info.passed ? `已过 ${days} 天` : days === 0 ? "就是今天" : `还剩 ${days} 天`;
    } else {
        head = info.passed ? `已经 ${days} 天` : days === 0 ? "从今天开始" : `还要 ${days} 天`;
    }
    return `<div class="syfe-pl__cdcard${cd.pinned ? " is-pinned" : ""}${info.passed && cd.kind === "until" ? " is-passed" : ""}"
        data-cd="${escapeHTML(cd.id)}" style="--pl-color:${escapeHTML(cd.color)}">
        <div class="syfe-pl__cdtop">
            <span class="syfe-pl__cdicon">${escapeHTML(cd.icon)}</span>
            <span class="syfe-pl__cdtitle">${escapeHTML(cd.title)}</span>
            <span class="fn__flex-1"></span>
            <span class="syfe-pl__cardacts">
                <span class="syfe-pl__cardact" data-act="pin" title="置顶">${cd.pinned ? "★" : "☆"}</span>
                <span class="syfe-pl__cardact" data-act="edit" title="编辑">✎</span>
                <span class="syfe-pl__cardact syfe-pl__danger" data-act="delete" title="删除">🗑</span>
            </span>
        </div>
        <div class="syfe-pl__cdnum">${head}</div>
        <div class="syfe-pl__cdmeta">
            <span>${escapeHTML(cd.repeatYearly ? "每年 " : "")}${escapeHTML(info.effective.slice(0, 4) === todayKey().slice(0, 4) ? "" : info.effective.slice(0, 4) + " 年")}${escapeHTML(formatCNFull(info.effective).replace(/^\d{4}年/, ""))}${cd.time ? " " + escapeHTML(cd.time) : ""}</span>
        </div>
        ${cd.note ? `<div class="syfe-pl__cdnote">${escapeHTML(cd.note)}</div>` : ""}
    </div>`;
}

/** 卡片下那一行的时间说明(今日视图/Dock 共用口径) */
export function continueCountdownLabel(cd: Countdown): string {
    return daysLabel(cd.date);
}
