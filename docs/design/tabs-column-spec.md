# Tabs column (tabs on the right): option B "Sections"

The chosen design for the Tabs column when tab placement is "right". It replaces the earlier card-per-group design. It uses only existing tokens (see `tokens.json` in the design handoff). Implement it exactly.

## Panel

| Part | Value |
|---|---|
| Background | `#161616` (surface), radius 14, no border |
| Header | 56px tall, padding `0 10px 0 18px`: "Tabs" (Geist 15px 500, `#F2F2F2`), the total count (Geist Mono 11px, `#8E8E8E`), then the icon buttons `layers` and `plus` (32×32, radius 9, `#A8A8A8`; hover bg `#222222`, icon `#F2F2F2`) |
| List padding | `0 8px 12px` |
| Gap between sections | 14px (loose tabs first, then each group) |
| Gap between rows | **2px**, so a highlighted row never touches its neighbours |

There are no cards, no tints and no borders. Spacing alone separates the groups.

## Tab row

| Part | Loose tab | Tab in a group |
|---|---|---|
| Height | 32px | 30px |
| Padding | `0 10px` | `0 10px 0 27px` (indented under the group name) |
| Agent tile | 22×22, radius 6 | 20×20, radius 6 |
| Radius | 10 | 10 |

Contents, left to right, with a 9px gap: the agent tile (the agent's official icon; `>_` on `rgba(236,111,62,0.16)` is a placeholder), the name (Geist 13px), the time (Geist Mono 10px, `#8E8E8E`), then the status badge (see `tokens.status`: 17px tall, radius 5, Geist Mono 9px 500 uppercase, letter-spacing 0.08em).

## Row states

| State | Background | Ring | Name |
|---|---|---|---|
| Default | transparent | none | `#E2E2E2`, 400 |
| Hover | `#1E1E1E` | none | `#F2F2F2` |
| Pressed | `#202020` | none | `#F2F2F2` |
| Active (the current tab) | `#242424` | inset 1px `#2C2C2C` | `#F2F2F2`, **500** |
| Active + hover | `#282828` | inset 1px `#333333` | `#F2F2F2`, 500 |
| Keyboard focus (`:focus-visible` only) | unchanged | outline 2px `#EC6F3E`, offset −2px | unchanged |
| Dragging (the row being moved) | `#262626` | inset 1px `#333333` + shadow `0 8px 24px rgba(0,0,0,0.45)` | `#F2F2F2` |

Background changes ease over 120ms. A row's status never changes its background; only the badge shows status.

## Group header

| Part | Value |
|---|---|
| Size | 30px tall, padding `0 10px 0 8px`, radius 9, gap 8px |
| Contents | `chevron-down` 11px, then the group name (Geist 13.5px **600**, in the group colour), the count (Geist Mono 11px), a spacer, a 7px `#EC6F3E` dot when any tab needs you, and done/total (Geist Mono 10.5px) |
| Default | bg transparent; chevron, count and done/total `#8E8E8E` |
| Hover | bg `#1C1C1C`; chevron, count and done/total `#CFCFCF` |
| Collapsed | chevron rotated −90°, tabs hidden, except the current tab (see Amendments) |
| Focus | outline 2px `#EC6F3E`, offset −2px |

Group colours (name text): blue `#8C9CF5`, violet `#B9A8F7`, teal `#6FCFAE`. Orange is never a group colour.

## Behaviour

- Clicking a row opens that tab and makes it the active row.
- Clicking a group header folds or unfolds the group.
- Drag a row to reorder it, or move it into another group. The rows slide apart to make room where it will land, as in the tab bar.
- Loose tabs (not in a group) always come first, then groups in the user's order.

## Amendments

Agreed with Zakiullah on 2026-11-01. These override the sections above.

- **Folded group holding the current tab:** show the group header and, under it, only the current tab's row in its active style.
- **New group button:** `layers`, the icon the right-click menu's New group uses. `group-new` is a plus in a tile, too close to the `plus` beside it.
- **No drop line:** the rows sliding apart show where a tab will land, as in the tab bar. Over a folded group, a room opens under its header.
- **Dragging shadow:** the `shadow_2xl` preset, not `0 8px 24px rgba(0,0,0,0.45)`, which mods can't set.
- **Keyboard focus:** `tabs-column.focus` (`cmd-shift-r`, `ctrl-shift-r`) brings the keyboard to the column. Up and down move, left and right fold and unfold a group, Enter opens a tab or folds a group, Esc returns to the terminal. The focus outline shows only then, never from the mouse.
- **Colors fill the rows, when picked:** rows are clear by default. A row's background is its tab's own color (`shared("tab.colors")`), else its group's if a person picked one (`fill`), in the new token `group_*_row`; hover, pressed and active deepen it, and an active row's ring is `group_*_ring`. The menu's none swatch clears either, and on a tab in a filled group it's stored as `"none"`. The group header stays as specified: no background, its color only on the name, and a name keeps its color under none. A color moves nothing.
- **New group is a draft:** the `layers` button and the menu's New group open a name and color with a Create group row, and nothing changes until it's pressed or Enter. On a tab already alone in a group, the button opens that group. A second press on either header button shuts its menu.
- **Order:** the tabs' real order is the column's, so a tab leaving a group lands at the end of the loose tabs, and a new group's section comes first among the groups.
- **Folding:** rows slide shut on the same spring as the rooms, and what's below follows.
- **New tokens:** `#E2E2E2`, `#202020`, `#282828`, `#262626` and `#333333` are the theme's `row_name`, `row_pressed`, `row_active_hover`, `row_dragging` and `row_ring`.
