/**
 * clean 纯逻辑：配置归一化、分类、阈值判定与区域点落（可单测）。
 */

export interface RecycleBinConfig {
  enabled: boolean;
  dimension: string;
  container_coords: [number, number, number];
  max_slots: number;
}

export interface CleanConfig {
  poll_interval_seconds: number;
  item_threshold_warning: number;
  countdown_seconds: number;
  kill_list: string[];
  recycle_bin: RecycleBinConfig;
}

export interface AreaBox2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export type EntityDisposition = "kill" | "recycle";

export const DEFAULT_CLEAN_CONFIG: CleanConfig = {
  poll_interval_seconds: 60,
  item_threshold_warning: 200,
  countdown_seconds: 10,
  kill_list: ["minecraft:xp_orb", "minecraft:tnt"],
  recycle_bin: {
    enabled: true,
    dimension: "minecraft:overworld",
    container_coords: [0, 64, 0],
    max_slots: 54,
  },
};

/** 秒 → tick（20 TPS）。 */
export function secondsToTicks(seconds: number): number {
  return Math.max(1, Math.floor(seconds * 20));
}

/** 归一化配置，非法字段回落默认值。 */
export function normalizeCleanConfig(raw: unknown): CleanConfig {
  const base = DEFAULT_CLEAN_CONFIG;
  if (!raw || typeof raw !== "object") return { ...base, kill_list: [...base.kill_list], recycle_bin: { ...base.recycle_bin } };

  const o = raw as Record<string, unknown>;
  const poll =
    typeof o.poll_interval_seconds === "number" && o.poll_interval_seconds > 0
      ? o.poll_interval_seconds
      : base.poll_interval_seconds;
  const threshold =
    typeof o.item_threshold_warning === "number" && o.item_threshold_warning > 0
      ? o.item_threshold_warning
      : base.item_threshold_warning;
  const countdown =
    typeof o.countdown_seconds === "number" && o.countdown_seconds >= 0
      ? o.countdown_seconds
      : base.countdown_seconds;

  const kill_list = Array.isArray(o.kill_list)
    ? o.kill_list.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [...base.kill_list];

  const rbRaw =
    o.recycle_bin && typeof o.recycle_bin === "object"
      ? (o.recycle_bin as Record<string, unknown>)
      : {};
  const coords = Array.isArray(rbRaw.container_coords)
    ? (rbRaw.container_coords as unknown[])
    : base.recycle_bin.container_coords;
  const cx = typeof coords[0] === "number" ? coords[0] : base.recycle_bin.container_coords[0];
  const cy = typeof coords[1] === "number" ? coords[1] : base.recycle_bin.container_coords[1];
  const cz = typeof coords[2] === "number" ? coords[2] : base.recycle_bin.container_coords[2];

  return {
    poll_interval_seconds: poll,
    item_threshold_warning: threshold,
    countdown_seconds: countdown,
    kill_list,
    recycle_bin: {
      enabled: rbRaw.enabled === false ? false : true,
      dimension:
        typeof rbRaw.dimension === "string" && rbRaw.dimension
          ? rbRaw.dimension
          : base.recycle_bin.dimension,
      container_coords: [cx, cy, cz],
      max_slots:
        typeof rbRaw.max_slots === "number" && rbRaw.max_slots > 0
          ? rbRaw.max_slots
          : base.recycle_bin.max_slots,
    },
  };
}

/** 实体处置：kill_list / 经验球 → 销毁，其余常规掉落物 → 回收。 */
export function classifyEntity(typeId: string, killList: readonly string[]): EntityDisposition {
  if (!typeId) return "kill";
  if (typeId === "minecraft:xp_orb") return "kill";
  if (killList.includes(typeId)) return "kill";
  if (typeId === "minecraft:item") return "recycle";
  // 非物品且在 kill_list 已覆盖；其它实体默认不处理（调用方应只枚举目标类型）
  return "kill";
}

/** 是否超过预警阈值。 */
export function shouldTriggerWarning(itemCount: number, threshold: number): boolean {
  return itemCount > threshold;
}

/** 从区域特性 params 解析私有阈值，缺省回落全局。 */
export function resolveAreaThreshold(
  params: Record<string, unknown> | undefined,
  globalThreshold: number,
): number {
  const raw = params?.item_threshold_warning ?? params?.threshold;
  if (typeof raw === "number" && raw > 0) return raw;
  return globalThreshold;
}

/** 2D 区域点落判定（XZ）。 */
export function pointInAreaBox(x: number, z: number, box: AreaBox2D): boolean {
  return x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;
}

/** 倒计时文案。 */
export function formatCountdownBroadcast(remaining: number, scopeLabel?: string): string {
  const where = scopeLabel ? `（${scopeLabel}）` : "";
  return `§e[清理] §f地表掉落物过多${where}，§c${remaining}§f 秒后开始回收，请尽快拾取贵重物品！`;
}

/** 清理完成文案。 */
export function formatCleanDoneBroadcast(cleanedCount: number, scopeLabel?: string): string {
  const where = scopeLabel ? `（${scopeLabel}）` : "";
  return `§a[清理] §f已完成掉落物清理${where}，共处理 §e${cleanedCount}§f 个实体。`;
}
