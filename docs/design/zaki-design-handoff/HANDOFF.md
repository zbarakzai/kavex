# Zaki UI — design handoff (v1 editor + v2 tabs)

This folder is the agreed design for Zaki's main window. Implement it in the app; don't redesign it.

- `tokens.json` — every colour, status, group colour, radius, size and type style. Use these values exactly.
- `screens/v1-editor.dc.html` — Version 1: sidebar, tab bar on top, real terminal, Changes panel (diff + file tree).
- `screens/v2-tabs.dc.html` — Version 2: the same window with tabs moved to a **Tabs column on the right**, with tab groups. Its `placement` prop switches between `right` and `top`.
- `screens/v2-tabs-top-wrapper.dc.html` — only mounts v2 with `placement="top"` (the grouped tab bar on top).

The `.dc.html` files are mockups in a small template format: `{{ }}` holes, `<sc-for>` loops, `<sc-if>` branches, and a `renderVals()` class at the bottom that holds the sample data and status mapping. They do not render on their own. Read them for exact markup, spacing and values; the sample data (tab names, diff lines, terminal text) is illustrative.

## Rules (the "clean UI" rule)

1. Clean, flat, quiet. Separate regions with fills and spacing, not outlines. Borders appear only as hairlines on panels, cards and pills (see tokens).
2. Window = three regions on `#0D0D0D` with 6px padding and 6px gaps: **sidebar** (≈230px, no background) · **terminal** (`surface`, radius 14, fills the rest) · **side panel** (`panel` + hairline border, radius 20).
3. The terminal is the real CLI (Claude Code, Codex, shell). There is **no chat composer**. Never draw an input box for the agent.
4. Orange (`accent`) means "you": the active tab glyph, the current space tile, "needs you", the Commit button, the prompt `❯`. Don't use it for decoration or as a group colour.
5. Labels and numbers are Geist Mono; names and controls are Geist. Section labels are small mono UPPERCASE with wide letter-spacing.
6. Menus are rounded: tab chips radius 13, pills radius 999 with a 1px inset ring, and one selected item per pill filled `#2A2A2A`.
7. Everything is single-line and dense enough for hundreds of items (files, tabs, agents).

## Sidebar

- Header: window controls, "Zaki", search.
- **SPACES**: one line per space: a 26px letter tile (`tile`; the current space's tile is solid `accent` with dark text) and the name. No branch under the space; the branch lives in the Changes panel.
- **AGENTS** (v1 only, see open questions): one line per agent: a 22px agent-icon tile, the space name plus ` · tab number`, a time (`<1m`, `32m`), and a status badge (see Status). No agent-name text, because the icon says which agent it is.
- Bottom: Settings, Add machine, then a mono line `● THIS COMPUTER · N AGENTS`.

## Tab bar (tabs on top)

- Tab chip: `>_` glyph + name + a 6px status dot. Inactive tabs are transparent with `textMuted`. The active tab is `chipActive` with an inset `chipActiveRing`, an orange `>_`, and a close ×.
- **Groups** (v2 top): a 40px rounded container filled with the group's `tint` and an inset `ring`. Inside are the **group name as bold text in the group colour** (not a badge) and then its tabs. Clicking the name collapses or expands the group. When collapsed it shows the name, a grey count, and an orange dot if any tab needs you.
- Right end: a **tab placement switch** (pill with two icon radios: tabs on top / tabs on the right; the current one filled), then the **Files & Changes** folder button (pressed fill `#262626` while the panel is open). These two controls are identical in v1 and v2.

## Tabs column (tabs on the right)

When placement = right, the tab bar is replaced by one chip showing the current tab (`>_ Claude Code  ~/path`), and a Tabs column opens on the right.

- Panel style is the same as the Changes panel. The header holds a "Tabs N" chip and a tool pill (new group, new tab).
- Loose tabs sit first, in a plain `card`.
- Each **group is a card** filled with the group's `cardOnPanel` colour, with a 1px border in the group's `ring`. The header shows the bold group name in its colour, a count, "N NEEDS YOU" (mono, orange) when relevant, done/total, and a chevron. Groups collapse.
- Each tab row is the same as an agent row: icon tile, tab name, meta (time, or steps like `3/5` while working), and status badge. The active tab row is `rowSelectedStrong`.
- Group colours come from `groupColors` (blue, violet, teal). Users pick a colour and rename groups; agents spawned by an orchestrator (`hc run`) can land in a group.

## Changes panel

- Header tabs: **Changes** (active chip with ×) and **Files**; expand button on the right.
- Pill row: the **scope pill** `Unstaged ⌄ +1,340 −140` (scopes: Unstaged, Staged, Branch, Last turn), the **branch pill** `⑂ feat/tab-groups ⌄`, and on the right a tool pill (find in diff, split view, file tree toggle, ⋯ holding refresh / wrap lines / hide unchanged).
- Two **cards side by side**:
  - **Diff card** (left, grows): a file header (`MD  defaults / AGENTS.md  +19 −2   1 / 59  ‹ ›`), then the diff. Added and removed lines get a row tint and a stronger gutter tint, with a `+` or `−` marker. There's no coloured edge bar. Unchanged runs collapse into a full-width "N unmodified lines" row. Long lines scroll horizontally.
  - **File tree card** (right, ≈240px): a filter field in a `well`, then a tree. Rows are 28px with a type tag (`MD`, `JS`, `TS`, `{ }`, `>_`), the name and `+N −N`. A folder with a single subfolder collapses into one line (`mods / changes`). The selected file is `#222` with an orange type tag.
- Footer (outside the cards): `NOTHING STAGED · 59 FILES`, then a rounded commit field with a `⌘↵` hint, then an orange **Commit** button. Commit takes what's staged, or everything.

## Status

One status vocabulary everywhere (sidebar, tab dots, tab rows): done, working, needs you, failed, idle, queued. The badge, dot and colour values are in `tokens.status`. Badges are 17px tall, radius 5, 9px mono uppercase.

## Open questions — ask Zaki before deciding

1. **Agent icons:** the orange `>_` tile is a placeholder. Zaki will supply the official Claude Code / Codex / Cursor icons as files.
2. **Sidebar AGENTS list:** v2 drops it because the Tabs column lists every agent. Keep it only when tabs are on top, or remove it everywhere?
3. **Step progress (`3/5`):** herdr's status protocol (OSC 7501) reports state only. Showing steps needs an extension to that protocol.
4. **Tab placement setting:** should it be per space (like panels) or global? Should Settings expose it as well as the switch?
5. **Files panel:** not designed yet. Reuse the Changes panel's header, card and tree styles.
