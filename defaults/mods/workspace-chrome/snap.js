// The sidebar is the rail or at least this wide: in between, an agent's row can't show its name.
export const SIDEBAR_MIN = 200;
// A drag can't be told from a stop, so the width settles once it holds still this long.
export const SETTLE_MS = 400;

// Where a sidebar this wide settles: the rail or the minimum, whichever is nearer; null if it's fine.
export function snapTarget(px, rail) {
  if (typeof px !== "number" || px <= rail || px >= SIDEBAR_MIN) return null;
  return px < (rail + SIDEBAR_MIN) / 2 ? rail : SIDEBAR_MIN;
}
