import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyEntity,
  formatCleanDoneBroadcast,
  formatCountdownBroadcast,
  normalizeCleanConfig,
  pointInAreaBox,
  resolveAreaThreshold,
  secondsToTicks,
  shouldTriggerWarning,
} from "../sapi/src/clean-core.ts";

describe("clean-core", () => {
  it("secondsToTicks", () => {
    assert.equal(secondsToTicks(10), 200);
    assert.equal(secondsToTicks(0), 1);
  });

  it("normalizeCleanConfig 回落默认并保留合法字段", () => {
    const cfg = normalizeCleanConfig({
      poll_interval_seconds: 30,
      item_threshold_warning: 100,
      countdown_seconds: 10,
      kill_list: ["minecraft:xp_orb"],
      recycle_bin: {
        enabled: true,
        dimension: "minecraft:overworld",
        container_coords: [1, 2, 3],
        max_slots: 27,
      },
    });
    assert.equal(cfg.poll_interval_seconds, 30);
    assert.equal(cfg.item_threshold_warning, 100);
    assert.deepEqual(cfg.kill_list, ["minecraft:xp_orb"]);
    assert.deepEqual(cfg.recycle_bin.container_coords, [1, 2, 3]);
  });

  it("classifyEntity：经验球/黑名单销毁，常规 item 回收", () => {
    const kill = ["minecraft:xp_orb", "minecraft:tnt"];
    assert.equal(classifyEntity("minecraft:xp_orb", kill), "kill");
    assert.equal(classifyEntity("minecraft:tnt", kill), "kill");
    assert.equal(classifyEntity("minecraft:item", kill), "recycle");
  });

  it("shouldTriggerWarning 严格大于阈值", () => {
    assert.equal(shouldTriggerWarning(200, 200), false);
    assert.equal(shouldTriggerWarning(201, 200), true);
  });

  it("resolveAreaThreshold 优先区域私有阈值", () => {
    assert.equal(resolveAreaThreshold({ item_threshold_warning: 50 }, 200), 50);
    assert.equal(resolveAreaThreshold({}, 200), 200);
  });

  it("pointInAreaBox", () => {
    const box = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
    assert.equal(pointInAreaBox(5, 5, box), true);
    assert.equal(pointInAreaBox(11, 5, box), false);
  });

  it("倒计时与完成广播含秒数与清理数", () => {
    assert.match(formatCountdownBroadcast(10), /10/);
    assert.match(formatCleanDoneBroadcast(42), /42/);
  });
});
