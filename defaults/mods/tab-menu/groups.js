// Tab groups, as any mod can read and edit them in shared state:
//   "tab.groups"   { id: { name, color, folded, tabs: [tab ids] } }
//   "tabs.picked"  [tab ids] picked with Cmd/Ctrl or Shift
//   "tabs.hold"    ms: until then, moves are under way and a split group isn't one to mend
// What's here keeps the tabs true to them, in the bar and the column alike. The `tabs`,
// `tabs-column` and `tab-menu` mods each keep a copy of this file; scripts/look.test.ts keeps
// them equal.

export const groupOf = (groups, tab) => Object.keys(groups).find((id) => groups[id].tabs.includes(tab)) ?? null;

export const HUES = ["blue", "violet", "teal"];

export function leastUsed(colors, groups) {
  const uses = (c) => Object.values(groups).filter((g) => g.color === c).length;
  return colors.reduce((best, c) => (uses(c) < uses(best) ? c : best));
}

// What a slot's key says, and the keyboard's stop on a group's name.
export const slotKey = { before: (id) => `before:${id}`, inside: (id) => `in:${id}`, fold: (id) => `fold:${id}` };
export const groupStop = (id) => `group:${id}`;
export const stoppedGroup = (stop) => (stop?.startsWith("group:") ? stop.slice("group:".length) : null);

// agents() and tabs fold a program's "error" into blocked; terminals() keeps the word.
export const failed = (c, ps, words) => (ps.some((p) => p.tab === c.id && words.get(p.terminal) === "error") ? "failed" : c.status);

// How a tab shows: the agent in it, else its first pane's program.
export function shows(c, ps) {
  const mine = ps.filter((p) => p.tab === c.id);
  const program = mine.find((p) => p.program?.agent)?.program ?? mine[0]?.program;
  return { program, cwd: mine.find((p) => p.cwd)?.cwd, name: /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name };
}

// `tabs.color`: the tab's next color, then none, which a filled group's tab has to say out loud.
export function nextColor(colors, tab, filled) {
  const { [tab]: _, ...rest } = colors, next = HUES[HUES.indexOf(colors[tab]) + 1] ?? (filled ? "none" : null);
  return next ? { ...rest, [tab]: next } : rest;
}

// `order` with a new group's tabs past the loose ones, ahead of every other group.
export function firstAmongGroups(order, groups, tabs) {
  const rest = order.filter((id) => !tabs.includes(id)), found = rest.findIndex((id) => groupOf(groups, id));
  const at = found < 0 ? rest.length : found;
  return [...rest.slice(0, at), ...order.filter((id) => tabs.includes(id)), ...rest.slice(at)];
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

// The tabs a fold puts away: never the shown one. The group's label says if one needs the person.
export function away(tabs, groups) {
  const folded = (t) => groups[groupOf(groups, t.id)]?.folded && !t.active;
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
export const GAP = 4;
export const INNER = 2; // between what's in a tray
const EDGE = 3; // a tray's border and padding, each side

// Where a drag can land, left to right, with what's moving taken out. `x`: where it would
// sit, `at`: its place among the tabs left, `group`: the group it would join, `key`: the
// room that opens for it. `width(key)` gives a tab's width, or `tag:<group>`.
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
      out.push({ key: slotKey.before(r.group), x, at, group: null });
      const tabs = r.tabs.filter((c) => !moving.tabs?.includes(c.id));
      const folded = tabs.some((c) => hidden.has(c.id));
      let end = x + EDGE + width(`tag:${r.group}`);
      if (folded && tray) out.push({ key: slotKey.fold(r.group), x: x + EDGE, at, group: r.group, fold: true });
      for (const c of tabs) {
        if (!hidden.has(c.id)) {
          if (tray) out.push({ key: c.id, x: end + INNER, at, group: r.group });
          end += INNER + width(c.id);
        }
        at++;
      }
      if (tray && !(folded && tabs.every((c) => hidden.has(c.id)))) out.push({ key: slotKey.inside(r.group), x: end + INNER, at, group: r.group });
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

export const nearestY = (list, y) => list.reduce((best, s) => (Math.abs(s.y - y) < Math.abs(best.y - y) ? s : best));

// What a click does to the picked tabs: Command (Ctrl elsewhere) picks one by one, Shift a
// range from the shown tab. Null: a plain click, which shows the tab.
export function clicked(tabs, c, { shift, picking }, picks) {
  if (shift) {
    const at = tabs.findIndex((x) => x.active), to = tabs.indexOf(c);
    return [...new Set([...picks, ...tabs.slice(Math.min(at, to), Math.max(at, to) + 1).map((x) => x.id)])];
  }
  if (picking) return picks.includes(c.id) ? picks.filter((id) => id !== c.id) : [...picks, c.id];
  return null;
}

// A tab whose terminal was started with `zaki.group=<name>` joins that group, made if it's new,
// in the color least used. The same answer however often it's asked.
export function labeled(groups, tab, name, colors, id) {
  if (groupOf(groups, tab) && groups[groupOf(groups, tab)].name === name) return groups;
  const left = Object.fromEntries(Object.entries(groups).map(([key, g]) => [key, { ...g, tabs: g.tabs.filter((t) => t !== tab) }]).filter(([, g]) => g.tabs.length));
  const home = Object.keys(left).find((key) => left[key].name === name);
  if (home) return { ...left, [home]: { ...left[home], tabs: [...left[home].tabs, tab] } };
  return { ...left, [id]: { name, color: leastUsed(colors, left), folded: false, tabs: [tab] } };
}

export const COLUMN = { row: 32, inRow: 30, head: 30, rowGap: 2, gap: 14 };

// Loose tabs, then each group's section, in tab order. A group is one section even while split.
export function columnRuns(tabs, groups) {
  const loose = [], sections = [];
  for (const r of runs(tabs, groups)) {
    if (r.tab) loose.push(r.tab);
    else if (sections.some((c) => c.group === r.group)) sections.find((c) => c.group === r.group).tabs.push(...r.tabs);
    else sections.push({ group: r.group, tabs: [...r.tabs] });
  }
  return { loose, sections };
}

// The order the column draws, so `tab.next` and the number keys go top to bottom, and a tab
// that leaves a group lands at the end of the loose tabs, not at some earlier place.
export function columnOrder(tabs, groups) {
  const { loose, sections } = columnRuns(tabs, groups);
  return [...loose, ...sections.flatMap((s) => s.tabs)].map((c) => c.id);
}

// A press outside a popup closes it and still reaches what's under it, so the button that opened
// the popup would open it again. `closed`: what a popup leaves in "popup.closed" as it goes, with
// the name of its button (the `from` prop). Closed by this press: the button only shuts it.
export const reopening = (closed, from, pressed) => closed?.from === from && closed.at >= pressed - 100;

export const shownIn = (g, tabs) => (g.folded ? tabs.filter((c) => c.active) : tabs);

export function sectionHeight(g, tabs) {
  return COLUMN.head + shownIn(g, tabs).length * (COLUMN.inRow + COLUMN.rowGap);
}

// What the keyboard stops on, top to bottom: tab ids, and `group:<id>` for a group's name.
export function columnStops(tabs, groups) {
  const { loose, sections } = columnRuns(tabs, groups);
  return [...loose.map((c) => c.id), ...sections.flatMap((s) => [groupStop(s.group), ...shownIn(groups[s.group], s.tabs).map((c) => c.id)])];
}

// Where a drag can land in the column, top to bottom, with what's moving taken out. Each has
// `y`, where what's moving would sit, its place among the tabs left (`at`), and the group it
// would join, as `slots` has for the bar, so `landed` takes either. Moving nothing gives every
// place, the shown tab of a folded group too, to find what's held.
export function columnSlots(tabs, groups, moving) {
  const ids = moving.tabs ?? groups[moving.group]?.tabs ?? [], going = (c) => ids.includes(c.id);
  const { loose, sections } = columnRuns(tabs, groups), rest = tabs.filter((c) => !going(c));
  const before = (c) => tabs.slice(0, tabs.indexOf(c)).filter((x) => !going(x)).length;
  const past = (c) => before(c) + (going(c) ? 0 : 1);
  const placing = !moving.group, stacking = !moving.tabs, out = [];
  const { row, inRow, head, rowGap, gap } = COLUMN;
  let y = 0;
  const stay = loose.filter((c) => !going(c));
  if (stay.length || moving.tabs) {
    stay.forEach((c) => {
      if (placing) out.push({ key: c.id, y, at: before(c), group: null });
      y += row + rowGap;
    });
    if (placing) out.push({ key: "loose-end", y, at: loose.length ? past(loose.at(-1)) : rest.length, group: null });
    if (loose.length) y += stay.length ? gap - rowGap : gap;
  }
  for (const section of sections) {
    if (section.group === moving.group) continue;
    const g = groups[section.group], left = section.tabs.filter((c) => !going(c)), shown = shownIn(g, left), end = past(section.tabs.at(-1));
    if (stacking) out.push({ key: slotKey.before(section.group), y, at: before(section.tabs[0]), group: null });
    if (placing && g.folded) out.push({ key: slotKey.fold(section.group), y, at: end, group: section.group, fold: true });
    y += head + rowGap;
    shown.forEach((c) => {
      if (placing && (!g.folded || !moving.tabs)) out.push({ key: c.id, y, at: before(c), group: section.group });
      y += inRow + rowGap;
    });
    if (placing && !g.folded) out.push({ key: slotKey.inside(section.group), y, at: end, group: section.group });
    y += gap - rowGap;
  }
  if (stacking) out.push({ key: "end", y, at: rest.length, group: null });
  return out;
}

// The slot a column drag starts from: the place of whatever comes after what's held.
export function columnHome(list, tabs, groups, moving) {
  const { loose, sections } = columnRuns(tabs, groups);
  if (moving.group) {
    const at = sections.findIndex((c) => c.group === moving.group);
    return list.find((s) => s.key === (sections[at + 1] ? slotKey.before(sections[at + 1].group) : "end"));
  }
  const first = tabs.find((c) => moving.tabs.includes(c.id)), section = sections.find((c) => c.tabs.includes(first));
  const near = section?.tabs ?? loose, next = near.slice(near.indexOf(first)).find((c) => !moving.tabs.includes(c.id));
  if (section && groups[section.group].folded) return list.find((s) => s.key === slotKey.fold(section.group));
  return list.find((s) => s.key === (next?.id ?? (section ? slotKey.inside(section.group) : "loose-end")));
}
