# Zaki icon set: request for Claude Design

Please draw one consistent set of **52 interface icons** for Zaki, a native desktop app for terminals and coding agents. Today's icons come from several sources and don't match.

The look follows the rest of the design: clean, flat, quiet. Rounded line icons, one weight, no decoration. They sit beside Geist and Geist Mono text in a dense dark window, so each must read at 12 to 16px.

Not in this request: agent and program logos (Claude, Codex, Cursor, Node, Docker and the rest in `defaults/icons/`), the Zaki app icon, and the Zaki 98 retro art.

## Format

Deliver one folder of `.svg` files, named exactly as in the tables below, with nothing else required.

| Rule | Value |
|---|---|
| File type | SVG 1.1, one file per icon |
| Canvas | `viewBox="0 0 24 24"`, with no `width` or `height` |
| Live area | 20 x 20, leaving 2 units clear on every side |
| Line | `fill="none" stroke="currentColor"`, `stroke-linecap="round"`, `stroke-linejoin="round"` |
| Line weight | 1.7 for icons drawn at 14px or larger; 2 to 2.2 for icons drawn at 11 to 13px |
| Corner radius | 2 to 3 units on rectangles |
| Background | Transparent |
| File names | Lowercase with hyphens, as listed |

**How the app draws them.** The app uses only each icon's shape and opacity, then paints it one color from the theme. So:

- One color only. Don't use gradients, shadows or two-tone fills: any color in the file is ignored.
- Opacity does work, so a fainter part is allowed where the table says so (`spinner`).
- No separate hover, active or disabled files. The app recolors the same icon for each state.
- Plain shapes only: `path`, `rect`, `circle`, `line`. No `<text>`, `<style>` or CSS classes, no filters, animation, masks or embedded images. Convert any lettering to outlines.
- Solid fills are fine where a shape needs one (`more`).

**It has to work on:** dark and light themes, and on normal screens as well as Retina. At 12px one grid unit is half a pixel, so keep details simple and leave at least 3 units between parallel lines.

Please include a contact sheet (one PNG showing all 52 at 16px, light on `#161616`) so the set can be reviewed at a glance.

## Basics (11)

| File | Means | Used for | Drawn at |
|---|---|---|---|
| `search` | Find | Sidebar search, file filter, jump to file | 14 to 16 |
| `plus` | Add | New space, new tab, new item in menus | 12 to 15 |
| `minus` | Remove | Remove from group, ungroup | 14 |
| `close` | Close | Close a tab, panel, dialog or toast | 12 to 14 |
| `check` | Selected, done | Current item in menus and pickers | 12 to 14 |
| `chevron-down` | Open, has a menu | Pills, open folders and groups | 11 to 12 |
| `chevron-right` | Closed, next | Closed folders and groups, next file | 11 to 13 |
| `chevron-left` | Previous | Previous file, back | 13 |
| `arrow-right` | Compared to, continue | "branch → base" pill, welcome's Next | 14 |
| `more` | More options | `⋯` menus. Three solid dots | 13 to 14 |
| `unfold` | Show hidden lines | "N unmodified lines" row in a diff | 12 |

## Window and tabs (7)

| File | Means | Used for | Drawn at |
|---|---|---|---|
| `tabs-top` | Tabs on top | Placement switch. A window with a bar across the top | 14 |
| `tabs-right` | Tabs on the right | Placement switch. A window with a column on the right. Must read as a pair with `tabs-top` | 14 |
| `folder` | Files | Files & Changes button, Files tab, welcome | 15 |
| `group-new` | New group | Tabs column tool pill. A rounded square with a plus | 14 |
| `sidebar` | Unfold the sidebar | Narrow sidebar rail | 15 |
| `panel-expand` | Widen the panel | Side panel header. Arrows pointing outward | 14 |
| `panel-shrink` | Narrow the panel | Side panel header. Arrows pointing inward | 14 |

## Changes panel (7)

| File | Means | Used for | Drawn at |
|---|---|---|---|
| `changes` | Changes | Changes tab, welcome. A document with plus and minus | 15 |
| `find-in-diff` | Find a file in the diff | Tool pill. A document with a magnifier | 14 |
| `split-view` | Side-by-side diff | Tool pill. Two columns of lines | 14 |
| `file-tree` | Show the file tree | Tool pill. A panel with a right column. May match `tabs-right` | 14 |
| `branch` | Git branch | Branch pill, new worktree, worktree rows | 13 to 14 |
| `commit` | Commit | Commit button. A circle on a line | 14 |
| `comment` | Comment on a line | Comments in a diff | 12 to 14 |

## Sidebar (8)

| File | Means | Used for | Drawn at |
|---|---|---|---|
| `settings` | Settings | Footer button. Two sliders | 15 |
| `machine` | Another machine | Add machine, remote machines. Two stacked server units | 13 to 16 |
| `this-computer` | This computer | Machine heading. A monitor | 13 |
| `sort-priority` | Sort by priority | Agents sort menu. A clock | 13 to 14 |
| `layers` | Groups | Sort by space, new group, group actions in menus | 14 |
| `pin` | Pin | Pin an agent to the top | 13 |
| `unpin` | Unpin | Same as `pin`, with a line through it | 13 |
| `terminal` | Terminal | Tabs chip, plain terminal tile, menus. A `>_` prompt | 14 to 16 |

## Panes and menus (5)

| File | Means | Used for | Drawn at |
|---|---|---|---|
| `split-right` | Split to the right | Pane header, right-click menu | 14 to 15 |
| `split-down` | Split downward | Pane header | 14 to 15 |
| `zoom` | Fill the window | Pane header, right-click menu | 14 to 15 |
| `unzoom` | Back to the split | Pane header. Must read as the opposite of `zoom` | 14 to 15 |
| `rename` | Rename | Menus. A pen on a square | 14 |

## Status (2)

| File | Means | Used for | Drawn at |
|---|---|---|---|
| `spinner` | Working | Loading states. The app rotates it around the center (12, 12), so keep it balanced. A full ring at 24% opacity with a solid quarter arc on top | 12 |
| `success` | Finished well | "Added" confirmation. A circle with a check | 13 |

## Settings and welcome (7)

| File | Means | Used for | Drawn at |
|---|---|---|---|
| `look` | Look | Settings nav, for theme and layout. A palette | 15 |
| `alerts` | Alerts | Settings nav. A bell | 15 |
| `updates` | Updates | Settings nav. Circular arrows | 15 |
| `privacy` | Privacy | Settings nav. A shield | 15 |
| `agent` | Agents | Welcome screen. A simple friendly robot, not any company's logo | 15 |
| `messages` | Agents helping each other | Welcome screen. Two chat bubbles | 15 |
| `command` | Command palette | Palette input. The ⌘ symbol | 16 |

## Terminals layout (1)

| File | Means | Used for | Drawn at |
|---|---|---|---|
| `stack` | Space picker | Terminals layout's title bar. Stacked sheets | 15 |

## Windows window controls (4)

Shown only on Windows, so they should look like Windows' own controls, not rounded like the rest. Use thin square-ended lines (`stroke-linecap="butt"`, weight 1.2) and keep them pixel-sharp at 16px.

| File | Means | Used for | Drawn at |
|---|---|---|---|
| `win-minimize` | Minimize | Top right of the window on Windows | 16 |
| `win-maximize` | Maximize | Same | 16 |
| `win-restore` | Restore | Same, shown while maximized | 16 |
| `win-close` | Close the window | Same | 16 |
