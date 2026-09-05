/**
 * clean 运行时：扫实体、回收箱转移、倒计时与周期巡检。
 */

import {
  system,
  world,
  type Container,
  type Dimension,
  type Entity,
} from "@minecraft/server";
import { debug, Msg } from "@sfmc-bds/sdk/sapi/runtime";
import {
  classifyEntity,
  formatCleanDoneBroadcast,
  formatCountdownBroadcast,
  pointInAreaBox,
  resolveAreaThreshold,
  secondsToTicks,
  shouldTriggerWarning,
  type AreaBox2D,
  type CleanConfig,
} from "./clean-core.js";

const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"] as const;

export interface CleanScope {
  /** 缺省为全服。 */
  areaName?: string;
  dimension?: string;
  box?: AreaBox2D;
}

export interface TriggerResult {
  ok: boolean;
  cleanedCount: number;
}

type JobState =
  | { kind: "idle" }
  | {
      kind: "countdown";
      remaining: number;
      scope: CleanScope;
      force: boolean;
      runId: number;
    };

let cfg: CleanConfig | null = null;
let job: JobState = { kind: "idle" };
let pollRunId: number | undefined;
let featureRegistered = false;

export function setCleanConfig(next: CleanConfig): void {
  cfg = next;
}

export function getCleanConfig(): CleanConfig | null {
  return cfg;
}

export function isFeatureRegistered(): boolean {
  return featureRegistered;
}

export function markFeatureRegistered(ok: boolean): void {
  featureRegistered = ok;
}

function broadcast(text: string): void {
  for (const p of world.getAllPlayers()) {
    Msg.info(text, p);
  }
}

function scopeKey(scope: CleanScope): string {
  return scope.areaName ? `area:${scope.areaName}` : "global";
}

function scopeLabel(scope: CleanScope): string | undefined {
  return scope.areaName ? `区域 ${scope.areaName}` : undefined;
}

function getDim(id: string): Dimension | undefined {
  try {
    return world.getDimension(id);
  } catch {
    return undefined;
  }
}

function inScope(entity: Entity, scope: CleanScope): boolean {
  if (scope.dimension && entity.dimension.id !== scope.dimension) return false;
  if (!scope.box) return true;
  const { x, z } = entity.location;
  return pointInAreaBox(x, z, scope.box);
}

/** 统计范围内 minecraft:item 数量。 */
export function countItemEntities(scope: CleanScope = {}): number {
  let n = 0;
  const dims = scope.dimension ? [scope.dimension] : [...DIMENSIONS];
  for (const dimId of dims) {
    const dim = getDim(dimId);
    if (!dim) continue;
    let entities: Entity[];
    try {
      entities = dim.getEntities({ type: "minecraft:item" });
    } catch {
      continue;
    }
    for (const e of entities) {
      if (inScope(e, scope)) n++;
    }
  }
  return n;
}

function getRecycleContainer(config: CleanConfig): Container | undefined {
  const rb = config.recycle_bin;
  if (!rb.enabled) return undefined;
  const dim = getDim(rb.dimension);
  if (!dim) return undefined;
  const [x, y, z] = rb.container_coords;
  try {
    const block = dim.getBlock({ x, y, z });
    const inv = block?.getComponent("minecraft:inventory");
    const container = inv && "container" in inv ? inv.container : undefined;
    return container ?? undefined;
  } catch (err) {
    debug.w(
      "Clean",
      `回收箱不可用: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function destroyEntity(entity: Entity): boolean {
  try {
    entity.remove();
    return true;
  } catch {
    try {
      return entity.kill();
    } catch {
      return false;
    }
  }
}

function tryRecycleItem(entity: Entity, container: Container | undefined, maxSlots: number): boolean {
  if (!container) return destroyEntity(entity);
  try {
    const itemComp = entity.getComponent("minecraft:item");
    const stack = itemComp && "itemStack" in itemComp ? itemComp.itemStack : undefined;
    if (!stack) return destroyEntity(entity);

    // 限制可用槽：仅写入前 max_slots 个
    const limit = Math.min(container.size, maxSlots);
    if (container.emptySlotsCount <= 0 || container.firstEmptySlot() === undefined) {
      return destroyEntity(entity);
    }
    const empty = container.firstEmptySlot();
    if (empty === undefined || empty >= limit) {
      return destroyEntity(entity);
    }

    const leftover = container.addItem(stack);
    // 无论是否完全装入，实体都移除（溢出安全清除）
    void leftover;
    return destroyEntity(entity);
  } catch (err) {
    debug.w("Clean", `回收失败: ${err instanceof Error ? err.message : String(err)}`);
    return destroyEntity(entity);
  }
}

/**
 * 执行一次清理：kill_list 销毁；常规掉落物进回收箱。
 * 分维度处理，避免单次过重。
 */
export function performClean(scope: CleanScope = {}): number {
  const config = cfg;
  if (!config) return 0;

  let cleaned = 0;
  const container = getRecycleContainer(config);
  const dims = scope.dimension ? [scope.dimension] : [...DIMENSIONS];
  const types = new Set<string>(["minecraft:item", ...config.kill_list]);

  for (const dimId of dims) {
    const dim = getDim(dimId);
    if (!dim) continue;
    for (const typeId of types) {
      let entities: Entity[];
      try {
        entities = dim.getEntities({ type: typeId });
      } catch {
        continue;
      }
      for (const entity of entities) {
        if (!inScope(entity, scope)) continue;
        const disposition = classifyEntity(entity.typeId, config.kill_list);
        let ok = false;
        if (disposition === "recycle" && entity.typeId === "minecraft:item") {
          ok = tryRecycleItem(entity, container, config.recycle_bin.max_slots);
        } else {
          ok = destroyEntity(entity);
        }
        if (ok) cleaned++;
      }
    }
  }
  return cleaned;
}

function clearCountdownJob(): void {
  if (job.kind === "countdown") {
    try {
      system.clearRun(job.runId);
    } catch {
      /* ignore */
    }
  }
  job = { kind: "idle" };
}

function finishClean(scope: CleanScope): TriggerResult {
  const cleanedCount = performClean(scope);
  broadcast(formatCleanDoneBroadcast(cleanedCount, scopeLabel(scope)));
  clearCountdownJob();
  return { ok: true, cleanedCount };
}

/**
 * 触发清理：force 立即执行；否则广播倒计时。
 * 同 scope 已在倒计时中则忽略重复触发（返回 ok:true, cleanedCount:0）。
 */
export function triggerClean(opts: {
  force?: boolean;
  scope?: CleanScope;
}): TriggerResult {
  const config = cfg;
  if (!config) return { ok: false, cleanedCount: 0 };

  const scope = opts.scope ?? {};
  const force = opts.force === true;

  if (force || config.countdown_seconds <= 0) {
    clearCountdownJob();
    return finishClean(scope);
  }

  if (job.kind === "countdown" && scopeKey(job.scope) === scopeKey(scope)) {
    return { ok: true, cleanedCount: 0 };
  }

  clearCountdownJob();
  let remaining = config.countdown_seconds;
  broadcast(formatCountdownBroadcast(remaining, scopeLabel(scope)));

  const runId = system.runInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      broadcast(formatCountdownBroadcast(remaining, scopeLabel(scope)));
      if (job.kind === "countdown") job.remaining = remaining;
      return;
    }
    finishClean(scope);
  }, secondsToTicks(1));

  job = { kind: "countdown", remaining, scope, force: false, runId };
  return { ok: true, cleanedCount: 0 };
}

/** 全服周期巡检：超限则启动倒计时清理。 */
export function pollGlobalOnce(): void {
  const config = cfg;
  if (!config) return;
  if (job.kind === "countdown") return;
  const count = countItemEntities({});
  if (!shouldTriggerWarning(count, config.item_threshold_warning)) return;
  debug.i("Clean", `全服掉落物超限 count=${count} threshold=${config.item_threshold_warning}`);
  triggerClean({ force: false, scope: {} });
}

/** 区域 onTick：按区域私有阈值扫描并清理。 */
export function onAreaCleanTick(
  ctx: { name: string; dimension: string; box: AreaBox2D; params: Record<string, unknown> },
): void {
  const config = cfg;
  if (!config) return;
  const threshold = resolveAreaThreshold(ctx.params, config.item_threshold_warning);
  const scope: CleanScope = {
    areaName: ctx.name,
    dimension: ctx.dimension,
    box: ctx.box,
  };
  if (job.kind === "countdown" && scopeKey(job.scope) === scopeKey(scope)) return;
  const count = countItemEntities(scope);
  if (!shouldTriggerWarning(count, threshold)) return;
  debug.i("Clean", `区域 ${ctx.name} 掉落物超限 count=${count} threshold=${threshold}`);
  triggerClean({ force: false, scope });
}

export function startPollLoop(): void {
  stopPollLoop();
  const config = cfg;
  if (!config) return;
  pollRunId = system.runInterval(() => pollGlobalOnce(), secondsToTicks(config.poll_interval_seconds));
}

export function stopPollLoop(): void {
  if (pollRunId !== undefined) {
    try {
      system.clearRun(pollRunId);
    } catch {
      /* ignore */
    }
    pollRunId = undefined;
  }
}

export function resetCleanRuntime(): void {
  clearCountdownJob();
  stopPollLoop();
  cfg = null;
  featureRegistered = false;
}
