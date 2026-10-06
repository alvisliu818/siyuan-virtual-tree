/** 渲染器注册表：渲染器可插拔，规则由用户在设置里配置。 */
import { getSettings } from "./settings";
import type { CodeRenderer, RenderMode, RenderRule } from "./types";

const renderers = new Map<string, CodeRenderer>();

export function registerRenderer(renderer: CodeRenderer): void {
    renderers.set(renderer.id, renderer);
}

export function getRenderer(id: string): CodeRenderer | undefined {
    return renderers.get(id);
}

export function listRenderers(): CodeRenderer[] {
    return Array.from(renderers.values());
}

export function findMode(renderer: CodeRenderer, modeId: string): RenderMode | undefined {
    return renderer.modes.find((m) => m.id === modeId) || renderer.modes[0];
}

/** 命中语言对应的启用规则（大小写不敏感） */
export function matchRule(lang: string): RenderRule | undefined {
    const key = (lang || "").trim().toLowerCase();
    if (!key) return undefined;
    return getSettings().rules.find((r) => r.enabled && r.lang.toLowerCase() === key);
}

export interface ResolvedRule {
    rule: RenderRule;
    renderer: CodeRenderer;
    mode: RenderMode;
}

export function resolveRule(lang: string): ResolvedRule | undefined {
    const rule = matchRule(lang);
    if (!rule) return undefined;
    const renderer = getRenderer(rule.rendererId);
    if (!renderer) return undefined;
    const mode = findMode(renderer, rule.modeId);
    if (!mode) return undefined;
    return { rule, renderer, mode };
}
