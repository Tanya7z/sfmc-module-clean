/**
 * @sfmc-bds/module-clean — 全服/区域掉落物预警与回收清理
 */

import { system, type Player } from "@minecraft/server";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import { Command, debug, Msg, Permission } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import { normalizeCleanConfig, type AreaBox2D } from "./clean-core.js";
import {
  isFeatureRegistered,
  markFeatureRegistered,
  onAreaCleanTick,
  resetCleanRuntime,
  setCleanConfig,
  startPollLoop,
  stopPollLoop,
  triggerClean,
  type CleanScope,
} from "./clean-runtime.js";

const MODULE_ID = "clean";
const unprovide: Array<() => void> = [];

interface AreaByNameResult {
  name?: string;
  dimension?: string;
  start?: [number, number];
  end?: [number, number];
}

function toBox(start: [number, number], end: [number, number]): AreaBox2D {
  return {
    minX: Math.min(start[0], end[0]),
    minZ: Math.min(start[1], end[1]),
    maxX: Math.max(start[0], end[0]),
    maxZ: Math.max(start[1], end[1]),
  };
}

async function loadConfig(): Promise<void> {
  const raw: Record<string, unknown> = {};
  for (const key of [
    "poll_interval_seconds",
    "item_threshold_warning",
    "countdown_seconds",
    "kill_list",
    "recycle_bin",
  ] as const) {
    raw[key] = await config.get(key);
  }
  setCleanConfig(normalizeCleanConfig(raw));
}

async function resolveScopeByAreaName(
  areaName: string,
): Promise<CleanScope | null> {
  try {
    const area = (await service.call("area.byName", {
      name: areaName,
    })) as AreaByNameResult | null;
    if (!area || !area.name || !area.dimension || !area.start || !area.end)
      return null;
    return {
      areaName: area.name,
      dimension: area.dimension,
      box: toBox(area.start, area.end),
    };
  } catch (err) {
    debug.w(
      "Clean",
      `area.byName 失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** 挂接 area.registerFeature（registerEvents 优先；init 可重试）。 */
async function registerCleanFeature(): Promise<boolean> {
  if (isFeatureRegistered()) return true;
  try {
    const result = (await service.call("area.registerFeature", {
      id: "clean",
      handler: {
        id: "clean",
        onTick(ctx: {
          name: string;
          dimension: string;
          box: AreaBox2D;
          params: Record<string, unknown>;
        }) {
          onAreaCleanTick(ctx);
        },
      },
    })) as { ok?: boolean } | undefined;
    const ok = result?.ok !== false;
    markFeatureRegistered(ok);
    if (ok) debug.i("Clean", "已挂接 area.registerFeature(clean)");
    return ok;
  } catch (err) {
    debug.w(
      "Clean",
      `area.registerFeature 暂不可用: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function handleTrigger(input: Record<string, unknown>): Promise<{
  ok: boolean;
  cleanedCount: number;
}> {
  const force = input.force === true;
  const areaName =
    typeof input.areaName === "string" ? input.areaName.trim() : "";
  let scope: CleanScope = {};
  if (areaName) {
    const resolved = await resolveScopeByAreaName(areaName);
    if (!resolved) return { ok: false, cleanedCount: 0 };
    scope = resolved;
  }
  return triggerClean({ force, scope });
}

function registerCommands(): void {
  Command.register(
    "clean",
    "clean.admin",
    (player: Player | undefined) => {
      const result = triggerClean({ force: false, scope: {} });
      if (player) {
        if (result.ok) Msg.success("已启动掉落物清理流程", player);
        else Msg.error("清理启动失败（配置未就绪）", player);
      } else {
        debug.i("Clean", `控制台触发 clean ok=${result.ok}`);
      }
    },
    "手动触发全服掉落物清理",
    MODULE_ID,
  );
}

registerCommands();

ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: true,
  lifecycle: {
    registerPermissions() {
      // 设计 OP(3) → SDK Permission.Admin
      Permission.register("clean.admin", Permission.Admin);
    },
    registerEvents() {
      // 规范要求在 registerEvents 挂接；area 的 provide 在 afterWorldLoad init，
      // 此处可能尚未就绪，失败时由 init 重试。
      void registerCleanFeature();
    },
    async init() {
      await loadConfig();
      config.onChange((key) => {
        if (
          key === "poll_interval_seconds" ||
          key === "item_threshold_warning" ||
          key === "countdown_seconds" ||
          key === "kill_list" ||
          key === "recycle_bin"
        ) {
          void loadConfig().then(() => {
            startPollLoop();
          });
        }
      });

      // area 在 afterWorldLoad init 中 provide；此处挂接 + 下一 tick 重试防竞态
      await registerCleanFeature();
      system.run(() => {
        void registerCleanFeature();
      });

      unprovide.push(
        service.provide("clean.trigger", (input) => handleTrigger(input ?? {})),
      );

      startPollLoop();
      debug.i("Clean", "init 全服掉落物周期扫描已启动");
    },
    cleanup() {
      for (const off of unprovide.splice(0, unprovide.length)) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      stopPollLoop();
      resetCleanRuntime();
      debug.i("Clean", "cleanup");
    },
  },
});
