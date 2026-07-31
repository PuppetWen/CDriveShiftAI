import type { EffectMode } from "../types";

export interface EffectDefinition {
  id: EffectMode;
  label: string;
  title: string;
  subtitle: string;
  background: string;
  colors: readonly string[];
}

export const effectDefinitions: readonly EffectDefinition[] = [
  {
    id: "aurora",
    label: "方块",
    title: "像素湖境",
    subtitle: "湖光远山 · 阶梯动画",
    background: "#183841",
    colors: ["#75c7cf", "#f0c66a", "#d8875c"]
  },
  {
    id: "matrix",
    label: "科技",
    title: "未来中枢",
    subtitle: "全息网格 · 数据脉冲",
    background: "#050815",
    colors: ["#58f6ff", "#5475ff", "#b66bff"]
  },
  {
    id: "calm",
    label: "晶境",
    title: "月白晶境",
    subtitle: "雾面玻璃 · 柔和微光",
    background: "#edf4f5",
    colors: ["#f7fbfc", "#b8dce2", "#7899b6"]
  }
];

export const effectLabels = Object.fromEntries(
  effectDefinitions.map((effect) => [effect.id, effect.label])
) as Record<EffectMode, string>;

export const effectBackgrounds = Object.fromEntries(
  effectDefinitions.map((effect) => [effect.id, effect.background])
) as Record<EffectMode, string>;
