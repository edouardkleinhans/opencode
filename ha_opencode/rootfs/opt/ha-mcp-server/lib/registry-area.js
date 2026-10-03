/** Assign or clear an explicit Home Assistant registry area through Core's API. */
export async function setRegistryArea({ kind, id, areaId }, command, invalidate) {
  if (kind !== "device" && kind !== "entity") throw new Error("Invalid registry kind");
  if (typeof id !== "string" || !id.trim() || id !== id.trim()) {
    throw new Error(`A ${kind} ID is required`);
  }
  if (areaId !== null && (typeof areaId !== "string" || !areaId.trim() || areaId !== areaId.trim())) {
    throw new Error("Use an area ID from get_areas, or null to clear the explicit area");
  }

  const collection = `config/${kind}_registry/list`;
  const key = kind === "device" ? "id" : "entity_id";
  // Bypass the five-minute read cache: a stale area or registry member must not
  // authorize a write (nor cause a false no-op).
  const [records, areas] = await Promise.all([
    command(collection),
    command("config/area_registry/list"),
  ]);
  const record = records.find((entry) => entry[key] === id);
  if (!record) throw new Error(`${kind} not found in Home Assistant's registry`);
  if (areaId !== null && !areas.some((entry) => entry.area_id === areaId)) {
    throw new Error("Area not found; use an area ID from get_areas");
  }

  const previousAreaId = record.area_id ?? null;
  if (previousAreaId === areaId) {
    return { kind, id, previous_area_id: previousAreaId, area_id: areaId, changed: false };
  }

  const updated = await command(`config/${kind}_registry/update`, { [kind === "device" ? "device_id" : "entity_id"]: id, area_id: areaId });
  invalidate(collection);
  const confirmed = kind === "entity" ? updated?.entity_entry : updated;
  if (confirmed?.area_id !== areaId) throw new Error("Home Assistant did not confirm the requested area");
  return { kind, id, previous_area_id: previousAreaId, area_id: areaId, changed: true };
}
