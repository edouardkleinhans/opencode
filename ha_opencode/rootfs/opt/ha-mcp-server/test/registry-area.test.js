import { describe, expect, it, vi } from "vitest";
import { setRegistryArea } from "../lib/registry-area.js";

const data = {
  "config/device_registry/list": [{ id: "device-1", area_id: "hall" }],
  "config/entity_registry/list": [{ entity_id: "light.desk", device_id: "device-1", area_id: null }],
  "config/area_registry/list": [{ area_id: "hall" }, { area_id: "office" }],
};

function mockCore() {
  const command = vi.fn(async (type, fields) => {
    if (type.endsWith("/list")) return data[type];
    return type === "config/entity_registry/update" ? { entity_entry: { ...fields } } : { ...fields };
  });
  const invalidate = vi.fn();
  return { command, invalidate };
}

describe("registry area assignment", () => {
  it("updates a device via Core's registry API and invalidates its cached listing", async () => {
    const { command, invalidate } = mockCore();
    const result = await setRegistryArea({ kind: "device", id: "device-1", areaId: "office" }, command, invalidate);
    expect(result).toEqual({ kind: "device", id: "device-1", previous_area_id: "hall", area_id: "office", changed: true });
    expect(command).toHaveBeenCalledWith("config/device_registry/update", { device_id: "device-1", area_id: "office" });
    expect(invalidate).toHaveBeenCalledWith("config/device_registry/list");
  });

  it("sets or clears an entity's explicit override without touching the device", async () => {
    const { command, invalidate } = mockCore();
    await setRegistryArea({ kind: "entity", id: "light.desk", areaId: "office" }, command, invalidate);
    expect(command).toHaveBeenCalledWith("config/entity_registry/update", { entity_id: "light.desk", area_id: "office" });
    expect(invalidate).toHaveBeenCalledWith("config/entity_registry/list");
    const cleared = mockCore();
    cleared.command.mockImplementation(async (type, fields) => {
      if (type === "config/entity_registry/list") return [{ ...data[type][0], area_id: "office" }];
      if (type === "config/entity_registry/update") return { entity_entry: { ...fields } };
      return data[type];
    });
    const result = await setRegistryArea({ kind: "entity", id: "light.desk", areaId: null }, cleared.command, cleared.invalidate);
    expect(result).toMatchObject({ previous_area_id: "office", area_id: null, changed: true });
    expect(cleared.command).toHaveBeenCalledWith("config/entity_registry/update", { entity_id: "light.desk", area_id: null });
  });

  it("fails closed on missing IDs or areas and skips writes when unchanged", async () => {
    const { command, invalidate } = mockCore();
    await expect(setRegistryArea({ kind: "device", id: "unknown", areaId: "office" }, command, invalidate)).rejects.toThrow("not found");
    await expect(setRegistryArea({ kind: "device", id: "device-1", areaId: "made-up" }, command, invalidate)).rejects.toThrow("Area not found");
    await expect(setRegistryArea({ kind: "device", id: "device-1", areaId: undefined }, command, invalidate)).rejects.toThrow("Use an area ID");
    const result = await setRegistryArea({ kind: "device", id: "device-1", areaId: "hall" }, command, invalidate);
    expect(result.changed).toBe(false);
    expect(command.mock.calls.some(([type]) => type.endsWith("/update"))).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does not claim success or invalidate reads if Home Assistant rejects the write", async () => {
    const { command, invalidate } = mockCore();
    command.mockImplementation(async (type) => {
      if (type.endsWith("/update")) throw new Error("Admin permission required");
      return data[type];
    });
    await expect(setRegistryArea({ kind: "device", id: "device-1", areaId: null }, command, invalidate)).rejects.toThrow("Admin permission required");
    expect(command).toHaveBeenCalledWith("config/device_registry/update", { device_id: "device-1", area_id: null });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("rejects an update response that does not confirm the requested area", async () => {
    const { command, invalidate } = mockCore();
    command.mockImplementation(async (type) => type.endsWith("/update") ? { area_id: "hall" } : data[type]);
    await expect(setRegistryArea({ kind: "device", id: "device-1", areaId: "office" }, command, invalidate)).rejects.toThrow("did not confirm");
    expect(invalidate).toHaveBeenCalledWith("config/device_registry/list");
  });
});
