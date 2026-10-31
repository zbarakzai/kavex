// Tab groups and colors, as any mod can read and edit them in shared state:
//   "tab.groups"   { id: { name, color, folded, tabs: [tab ids] } }
//   "tab.colors"   { tab id: color, or "none" for no color, even in a colored folder }
//   "tab.folders"  [{ machine, folder, color }]: every tab there wears that color
// What's here keeps the tabs true to them: a group's tabs side by side, a folded
// group's tabs put away.

// The same hues as the space avatars, so a color means one thing across the window.
export const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

export const hue = (color) => (color?.startsWith("#") ? color : MARK[color] ?? null);

export const groupOf = (groups, tab) => Object.keys(groups).find((id) => groups[id].tabs.includes(tab)) ?? null;

// What a tab wears: its own color, else its group's, else the deepest folder it's in.
export function colorOf(tab, { groups, colors, folders }, cwd, machine) {
  if (colors[tab] && colors[tab] !== "none") return colors[tab];
  const group = groups[groupOf(groups, tab)];
  if (group) return group.color;
  if (colors[tab]) return null;
  const inside = (f) => f.machine === machine && cwd && (cwd === f.folder || cwd.startsWith(`${f.folder}/`) || cwd.startsWith(`${f.folder}\\`));
  return folders.filter(inside).sort((a, b) => b.folder.length - a.folder.length)[0]?.color ?? null;
}

// The bar's items in order: a tab, or a group with its tabs.
export function runs(tabs, groups) {
  const out = [];
  for (const tab of tabs) {
    const group = groupOf(groups, tab.id);
    if (group && out.at(-1)?.group === group) out.at(-1).tabs.push(tab);
    else out.push(group ? { group, tabs: [tab] } : { tab });
  }
  return out;
}

// The longest unbroken stretch of these tabs in `order`, the first of equals.
function longest(order, tabs) {
  let best = [], now = [];
  for (const id of order) {
    now = tabs.includes(id) ? [...now, id] : [];
    if (now.length > best.length) best = now;
  }
  return best;
}

// `order` with each group side by side. The group stays where most of it is and the
// strays come to it, so adding a tab never makes the group jump.
export function gathered(order, groups) {
  let out = order;
  for (const group of Object.values(groups)) {
    const stay = longest(out, group.tabs);
    const strays = out.filter((id) => group.tabs.includes(id) && !stay.includes(id));
    if (!strays.length) continue;
    const rest = out.filter((id) => !strays.includes(id));
    const at = rest.indexOf(stay.at(-1)) + 1;
    out = [...rest.slice(0, at), ...strays, ...rest.slice(at)];
  }
  return out;
}

// The tab.move calls that turn `from` into `to`.
export function moves(from, to) {
  const now = [...from], out = [];
  to.forEach((id, i) => {
    if (now[i] === id) return;
    now.splice(now.indexOf(id), 1);
    now.splice(i, 0, id);
    out.push({ id, index: i + 1 });
  });
  return out;
}

// The tabs a fold puts away: never the shown one, or one that needs the person.
export function away(tabs, groups) {
  const folded = (t) => groups[groupOf(groups, t.id)]?.folded && !t.active && t.status !== "blocked" && t.status !== "done";
  return new Set(tabs.filter(folded).map((t) => t.id));
}

// Groups without the tabs that are gone. `kept(tab)`: there, or its machine is away for now.
export function pruned(groups, kept) {
  const left = Object.entries(groups).map(([id, g]) => [id, { ...g, tabs: g.tabs.filter(kept) }]);
  return Object.fromEntries(left.filter(([, g]) => g.tabs.length));
}

// The next tab a mouse wheel steps to, or null at either end: stepping round from
// the last tab to the first sent the whole bar flying.
export function stepped(tabs, forward) {
  const list = tabs.filter((c) => !c.settled);
  return list[list.findIndex((c) => c.active) + (forward ? 1 : -1)] ?? null;
}

// The bar's spacing, as it draws it.
export const GAP = 3;
const EDGE = 6; // a tray's margin, border and padding, each side

// Where a drag can land, left to right, with what's moving taken out. `x`: where it would
// sit, `at`: its place among the tabs left, `group`: the group it would join, `key`: the
// room that opens for it. `width(key)` gives a tab's width, or `tag:<group>`, `lights:<group>`.
export function slots(bar, moving, width, hidden) {
  const out = [];
  const tray = !moving.group; // a group lands beside groups, never in one
  let x = 0, at = 0;
  for (const r of bar) {
    if (r.tab) {
      if (moving.tabs?.includes(r.tab.id)) continue;
      out.push({ key: r.tab.id, x, at, group: null });
      x += width(r.tab.id) + GAP;
      at++;
    } else if (r.group !== moving.group) {
      out.push({ key: `before:${r.group}`, x, at, group: null });
      const tabs = r.tabs.filter((c) => !moving.tabs?.includes(c.id));
      const folded = tabs.some((c) => hidden.has(c.id));
      let end = x + EDGE + width(`tag:${r.group}`);
      if (folded) {
        if (tray) out.push({ key: `fold:${r.group}`, x: x + EDGE, at, group: r.group, fold: true });
        end += GAP + width(`lights:${r.group}`);
      }
      for (const c of tabs) {
        if (!hidden.has(c.id)) {
          if (tray) out.push({ key: c.id, x: end + GAP, at, group: r.group });
          end += GAP + width(c.id);
        }
        at++;
      }
      if (tray && !(folded && tabs.every((c) => hidden.has(c.id)))) out.push({ key: `in:${r.group}`, x: end + GAP, at, group: r.group });
      x = end + EDGE + GAP;
    }
  }
  out.push({ key: "end", x, at, group: null });
  return out;
}

export const nearest = (list, x) => list.reduce((best, s) => (Math.abs(s.x - x) < Math.abs(best.x - x) ? s : best));

// The slot a drag starts from: where it already is.
export function home(list, order, groups, moving) {
  const ids = moving.tabs ?? groups[moving.group].tabs;
  const first = order.findIndex((id) => ids.includes(id));
  const at = order.slice(0, first).filter((id) => !ids.includes(id)).length;
  const group = moving.tabs ? groupOf(groups, order[first]) : null;
  return list.find((s) => !s.fold && s.at === at && s.group === group) ?? list.at(-1);
}

// What a landing does: the new order and groups, or null when nothing changes.
export function landed(order, groups, moving, slot) {
  const ids = moving.tabs ?? groups[moving.group].tabs;
  const rest = order.filter((id) => !ids.includes(id));
  const next = [...rest.slice(0, slot.at), ...order.filter((id) => ids.includes(id)), ...rest.slice(slot.at)];
  const stayed = moving.group || ids.every((id) => groupOf(groups, id) === slot.group);
  if (stayed && next.every((id, i) => id === order[i])) return null;
  if (moving.group) return { order: next, groups };
  const joined = Object.entries(groups).map(([id, g]) => [id, { ...g, tabs: [...g.tabs.filter((t) => !ids.includes(t)), ...(id === slot.group ? ids : [])] }]);
  return { order: next, groups: Object.fromEntries(joined.filter(([, g]) => g.tabs.length)) };
}
