// The sidebar is the rail or at least this wide: in between, an agent's row can't show its name.
export const SIDEBAR_MIN = 200;
export const SIDEBAR_RAIL = 48;
// Let a width set outside the default divider drag hold still before settling it.
export const SETTLE_MS = 400;

// Where a sidebar this wide settles: the rail or the minimum, whichever is nearer; null if it's fine.
export function snapTarget(px) {
  if (!Number.isFinite(px) || px === SIDEBAR_RAIL || px >= SIDEBAR_MIN) return null;
  return px < (SIDEBAR_RAIL + SIDEBAR_MIN) / 2 ? SIDEBAR_RAIL : SIDEBAR_MIN;
}
