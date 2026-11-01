# Zaki changelog

## [0.4.0] - 2026-11-01

### New
- **A new design.** A new default dark theme, a redrawn sidebar, tab bar and panels, and Geist Mono 13 as the terminal font. Your own theme and font settings stay. The status bar is gone. (#3)
- **Colors you pick.** Colors come in blue, violet and teal. Pick one for a tab, or with tabs on the right for a group to fill the tabs in it, and pick none to clear it. Tabs stay clear until you do, and colors set on folders are kept but no longer shown. (#3)
- **Tabs on the right.** Move your tabs into a column beside your terminals, with the switch in the tab bar or in Settings > Look. Loose tabs come first, then each group. Drag a tab to reorder it or move it into a group, and the rows slide apart to make room. (#3)
- **Grouping does what you pick.** A new group waits until you press Create group, so choosing its name and color moves nothing. With tabs on the right, folding slides a group shut, a new group comes first among your groups, tabs leaving a group land at the end of your loose tabs, and the next-tab keys go top to bottom. (#3)
- **The Tabs column from the keyboard.** With tabs on the right, `cmd-shift-r` (`ctrl-shift-r`) moves the keyboard onto the column: arrows move, Enter opens a tab or folds a group, Esc goes back to the terminal. On a new install it just works. An existing `keys.json` needs `"cmd-shift-r": "tabs-column.focus"` (`"ctrl-shift-r"` on Linux and Windows) added under `layout:main`. (#3)
- **Files uses the Changes tree.** The Files panel now has the same tree as Changes, with file types, folds and single-folder paths on one line. (#3)
- **Right-click in Files.** Create, rename and delete files, cd or open a tab there, reveal them, attach them to an agent, or copy their path. Deleting always asks. On your computer it goes to the Trash, and on another machine it's gone for good. (#3)
- **Switch branch from Changes.** The branch pill shows your branch and switches it, and refuses to overwrite uncommitted work. (#3)
- **Settings in the new design.** Settings now looks like the rest of Zaki, and Settings > Look has switches to turn the Files and Changes panels off or on. (#3)
- **Softer menus and dialogs.** Every menu, dropdown and dialog has the same rounded corners and fades in smoothly as it opens. (#3)
- **A new logo.** The ram is now Zaki's app icon, and it sits beside the name at the top of the sidebar. (#3)
- **New interface icons.** One matching set across the app. Personal mods can load them from `mods/workspace-chrome/icons/`. The old icon paths still work in this release and will be removed in the next one, and so will the status bar's mod, kept for layouts you cloned. (#3)
- **Language logos in the file trees.** Files and Changes show each file's real logo, such as React, Python or Rust, in your theme's color. (#3)
- **Context on every agent.** Each Claude Code, Codex and Pi row in Agents, and its tab in the Tabs column, shows how full its session's context is, orange from 90%. (#8)
- **A dropdown on the agent's logo.** Click an agent's logo to see its model, a context bar, its API cost and its token counts. On a subscription, API cost is what the session would cost on the API, not what you paid. The chevron still folds sub-agents. (#8)
- **Zaki adds a hook to Codex.** To tell agents apart, Zaki adds a small hook to `~/.codex/hooks.json` by itself, keeping your own hooks, and keeps its script in `~/.zaki`. Zaki never approves it: run `/hooks` in Codex once, trust Zaki's hook and restart that Codex. Until then its row shows `–`. (#8)
- **Zaki adds an extension to Pi.** To tell agents apart, Zaki adds a small extension at `~/.pi/agent/extensions/zaki-session.ts` by itself, keeping your other extensions. There's nothing to approve. A Pi already running needs `/reload`, and until then its row shows `–`. (#8)
- **Softer bars from agents.** The gray bars agents draw behind your messages and their input box are now soft, rounded and the same height. (#8)
- **Usage limits in the sidebar.** A gauge in the sidebar's footer shows how much of your Claude Code, Codex and OpenCode Go subscriptions is left, each limit with its time to reset. Settings turns it off. (#6)
- **A warning before you run out.** Usage limits say when you'd run out at your current pace, and a toast warns you at 90%. (#7)
- **A Markdown reader.** Read Markdown files in the Files panel, opened from any terminal. (#5)
- **A new loader and start screen.** Working agents show a triangle loader, and with no space open you get an animated ram and a code trail. (#4)
- **The picker and Add a machine in the new design.** Both now look like the rest of Zaki. (#6)

## [0.3.0] - 2026-10-31

### New
- **Group and color tabs.** Right-click a tab to group or color it. A folded group shows each tab as a small light, and the tab bar makes room as you drag.
- **A new Changes panel.** See unstaged or staged work, a commit, a branch or the last agent turn, beside a file tree you can filter.
- **Stage, revert and commit from the diff.** Act on a hunk, a file or the whole diff without leaving the panel.
- **Comment on a diff.** Hover a line to add a comment, then send your comments to an agent in the space.
- **Panels slide open and shut.** On a new install `cmd-shift-b` (`ctrl-shift-j`) shows or hides them. An existing `keys.json` needs `layout.toggle:panel` added under `layout:main`.

### Fixed
- Folders in the Files panel open faster on Windows.
- A folder you reopen in the Files panel shows its files at once.

## [0.2.0] - 2026-10-31

### New
- Herdr is now Zaki: a new name, a new logo, and its own settings in `~/.config/zaki`.
- Zaki installs and updates from its own private link, on macOS, Linux and Windows.
- Zaki sends no usage data or feedback.

## [0.1.10] - 2026-10-30

### Fixed
- Images that Claude Code, yazi and other programs draw with kitty placeholders show up instead of rows of boxes. (#110)
- Images are the right size and sharp on Retina and other HiDPI screens. (#70, thanks @wpdmitry)
- Hover effects work in Claude Code and other programs that track the mouse.
- A drag that starts in another pane no longer reaches nvim or tmux, and a drag inside one keeps working when you let go outside it.
- Dragging a selection past the top or bottom of a terminal scrolls it.
- Closing a tab or space no longer brings its terminals back as unnamed tabs for a moment. (#108)
- The + menu starts agents with 1 to 9 while it's open, and shows your own shortcuts. (#102, #133, thanks @notHuman9504)
- Add a machine lists every host in your SSH config and shows the install prompt on top. (#95)
- Your own alert sounds play, and sound changes apply without a restart.
- A layout block that shows the focused agent stays in your layout when that agent ends.
- The Files panel keeps your open folders and preview when you switch spaces. (#86, thanks @ruilopesm)
- Dragging a space in the sidebar shows where it will land. (#114, thanks @takahashi-seiryu)
- Long agent titles cut off before the pin and the time. (#127, thanks @rashim2104)
- The + above Spaces lines up with the sidebar button. (#121, thanks @weskor)
- On macOS, a slow mouse wheel scrolls terminals. (#80, thanks @juanibiapina)
- On macOS, Cmd+V pastes copied files and screenshots into agents. (#105, thanks @WesleyBLDC)
- On macOS, Cmd+Shift+[ and ] switch tabs, and other Shift+punctuation shortcuts work.
- On macOS, Option types [ ] { } on ABC-QWERTZ and ABC-AZERTY.
- On macOS, Vietnamese Telex and other input methods compose. (#93)
- On macOS, keys typed with Fn held, like Fn+Esc for a backtick, reach terminals.
- On macOS, agents started from the + menu load your login setup, like Homebrew's PATH.
- On Windows, Ctrl+V pastes text, like Windows Terminal.
- On Windows, the Files panel opens folders with spaces or parentheses in their path. (#130)
- On Windows, the window buttons line up and stay crisp at every display scale.
- On Linux, Chinese typed through fcitx or ibus on X11 comes out right. (#97)
- On Linux, accent keys no longer type a stray character first. (#87, thanks @ruilopesm)
- On Linux, right-clicking a tab no longer opens the window manager's menu too. (#79, thanks @dev-gvs)
- `terminal.open` with a command starts in the folder you give it.
- `herdr-app check` no longer crashes on mods with scrolling lists or layout animations.

## [0.1.9] - 2026-10-30

### Fixed
- On macOS, updates keep Herdr's Apple signature again, so macOS stops forgetting the permissions you gave Herdr.
- Herdr no longer uses CPU in the background when the Changes or Files panel is open in a git repo.
- Mods use less CPU while they wait for work.

## [0.1.8] - 2026-10-30

### New
- **Option works as Alt on macOS.** Claude Code's Option shortcuts work, automatically on US keyboards. Change it with `option_as_alt` in settings.json.
- **Programs can copy to your clipboard,** also from other machines. Pi's or Claude Code's own mouse selection lands on your clipboard.
- **Your own commands in the + menu.** Entries in programs.json show up, shell functions included.

### Fixed
- Accent keys work on macOS and with ibus on Linux, and Caps Lock types capitals on macOS.
- @, [ and friends type on Slovenian, German and other Mac layouts in every program.
- Terminal colors show exactly as programs set them, so powerline prompts look right.
- Double-click selects a word, triple-click a line.
- Agents start from the + menu under fish, and one that fails at launch says why.
- On macOS, the window buttons stay clear of a narrow sidebar and the tabs.
- You can type a commit message in the Changes panel.
- Spaces named with emoji or accents work everywhere.
- The font list in Settings scrolls on its own.
- A downloaded update installs at the next start, even after a crash.

## [0.1.7] - 2026-10-29

### Fixed
- Herdr no longer freezes when a terminal shows an older Nerd Font icon it has no picture for, like some powerlevel10k battery icons. It draws them as text instead.

## [0.1.6] - 2026-10-29

### New
- **Coming from herdr?** The welcome says what carries over and gives you one line for your agent to bring your keybinds and settings across. Open it again with Show the welcome again in the command palette.
- **Updates at a glance.** Settings → Updates shows the app and the core on one row each, with What's new a click away.
- **herdr-core updates with Herdr.** After Herdr updates, its core moves to the latest version too. Your terminals keep running.
- **Screenshots in feedback.** Drop images straight onto the feedback form.

### Fixed
- Paste and copy in a peek go to the terminal you're peeking at, not the agent behind it.
- Scroll back through thousands of lines instead of a few hundred.
- Mod data, like topics and colors, can't get lost if Herdr closes in the middle of saving.
- Commands with an argument they don't know say so instead of acting on the current terminal.
- On Windows, file links at the end of a sentence open the right file.

## [0.1.5] - 2026-10-27
<!-- spotlight -->

### New
- **Drag panes where you want them.** Hover the top of a pane and grab the dots. Drop it on another pane to swap them, or near an edge to put it beside. A highlight shows where it lands.
  ![Dragging a pane beside another](https://media.herdr.dev/0.1.5/pane-drag.webp)
- **Ctrl-click a terminal to peek at it.** When an agent mentions another terminal, like t2, Ctrl-click (Cmd on macOS) its address to see it over your tab. Go to jumps there.
  ![Peeking at a terminal an agent mentioned](https://media.herdr.dev/0.1.5/peek.webp)
- **Agents can see the window.** `herdr-app shot` saves a picture of Herdr as it looks right now, so an agent building a mod can check its work. `herdr-app --skill` and `hc --skill` teach an agent the rest.
- **What changed, after every update.** Release notes like these, in Settings → Updates, including versions you skipped.

### Fixed
- nvim and other full-screen programs redraw right after you resize their pane.
- On Windows, AltGr and accent keys type the right characters, and Shift+Enter adds a new line in Claude Code.
- On Windows, new terminals start in PowerShell 7 when you have it, and Herdr follows their folder.
- On macOS, Herdr keeps the permissions you gave it across updates.
- Short menus open next to the pointer instead of near the top of the window.
- Removing a worktree asks once, then removes it.
- Mods can fetch from the web, know their size, and clean up when they close.

## [0.1.4] - 2026-10-23
<!-- spotlight -->

### New
- **See the agents that need you first.** Pick Priority beside the Agents title: agents waiting on you, then the ones that just finished, then the ones still working. Grouped by space is still there.
- **Pin the ones you're watching.** Hover an agent and click the pin. Pinned agents stay on top in both views until they end.
- **Fold what you don't need.** Click a space or section header to fold it; the header still shows how many agents are inside.

### Fixed
- Temporary agent sandboxes stay out of your spaces and machine lists.
- The agents list keeps its place when you scroll.
- An agent you're in moves to its new section right away.
- A pane closes when its terminal finishes instead of showing “has finished”.
- On macOS, the red close button hides Herdr instead of leaving it without a window.
- Mods reload cleanly when you save them, and tell you when a save didn't load.
