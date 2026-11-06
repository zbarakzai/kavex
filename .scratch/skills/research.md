# Skills page: research

Researched 2026-11-05. Source code was read from shallow clones at these commits (links below are pinned to them):

- openai/codex `e934edd` · openai/skills `49f948f` · anthropics/skills `ca45fc4` · mattpocock/skills `4ae2317`
- vercel-labs/skills `cabe072` (npm `skills` 1.7.6) · numman-ali/openskills `57d933a` · badlogic/pi-mono `d9af3d7`
- google-gemini/gemini-cli `3fd7d26` · sst/opencode `386229c`

Short link prefixes used below:

- `CX` = https://github.com/openai/codex/blob/e934edd68c73da93486320c77af672a015b4514a
- `VS` = https://github.com/vercel-labs/skills/blob/cabe07254cddf16a3a650253f0ba03d543d8a86e
- `CC` = https://code.claude.com/docs/en (Markdown at `<page>.md`)

Every claim below has a source. Anything marked **unverified** has none.

---

## 1. Codex (openai/codex)

### Where skills are found (scopes)
- Search roots, from `CX/codex-rs/ext/skills/src/host_roots.rs#L127-L190`:
  - **User**: `$CODEX_HOME/skills` (labelled "Deprecated user skills location… kept for backward compatibility", L151-157) and `~/.agents/skills` (L159-165).
  - **System**: `$CODEX_HOME/skills/.system` (L167-171).
  - **Admin**: `<system config folder>/skills`, which is `/etc/codex/skills` on Unix (L173-178; `/etc/codex/config.toml` is at `CX/codex-rs/config/src/loader/mod.rs#L81`).
  - **Repo**: `<project config folder>/skills`, i.e. `.codex/skills` (L141-148), plus `.agents/skills` in every folder from the project root down to the cwd (`repo_agents_skill_roots`, L192-260).
- The docs list the same table: `$CWD/.agents/skills`, parent folders, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills`, and "SYSTEM: Bundled with Codex". https://learn.chatgpt.com/docs/build-skills (the old URL https://developers.openai.com/codex/skills redirects there; linked from `CX/docs/skills.md`).
- Symlinked skill folders are followed for User, Repo and Admin roots and ignored for System roots: `CX/codex-rs/ext/skills/src/loader/host.rs#L161-L164`.
- Scan limits: up to 6 levels deep and 2000 skill folders per root, `CX/codex-rs/ext/skills/src/loader/mod.rs#L19-L27`.

### System skills
- They are compiled into the binary (`include_dir!("…/src/assets/samples")`) and written to `$CODEX_HOME/skills/.system` on start. A fingerprint marker file `.codex-system-skills.marker` skips the rewrite when nothing changed, and the folder is wiped and rewritten when the fingerprint differs: `CX/codex-rs/skills/src/lib.rs#L58-L104`.
- The bundled set is `imagegen`, `openai-docs`, `review-agent`, `skill-creator` and `skill-installer` (`CX/codex-rs/skills/src/assets/samples/`).
- To turn bundled skills off: `[skills.bundled] enabled = false` (`CX/codex-rs/config/src/skills_config.rs#L58-L69`, docs above).

### SKILL.md and `agents/openai.yaml`
- The frontmatter parser reads only `name` (defaults to the folder name, max 64 characters), `description` (required) and `metadata.short-description`: `CX/codex-rs/skills/src/parser.rs#L6-L20,L64-L85`. It also repairs prose YAML such as `description: Build for AWS: ECS` (L52-58).
- Optional UI and policy metadata lives in `<skill>/agents/openai.yaml` (`CX/codex-rs/ext/skills/src/loader/mod.rs#L21-L23`):
  - `interface`: `display_name`, `short_description`, `icon_small`, `icon_large` (paths inside the skill), `brand_color`, `default_prompt` (`CX/codex-rs/skills/src/interface.rs#L13-L22`)
  - `policy.allow_implicit_invocation` and `policy.products`
  - `dependencies.tools` (for example an MCP server) (`CX/codex-rs/skills/src/metadata.rs#L26-L58`)
- Example: `CX/codex-rs/skills/src/assets/samples/skill-installer/agents/openai.yaml` sets `display_name`, `short_description` and two icons in `./assets/`.

### Enable and disable
- `[[skills.config]]` entries go in `~/.codex/config.toml`. Each entry has `path` (absolute path to the SKILL.md) **or** `name`, plus `enabled`, and the last match wins: `CX/codex-rs/config/src/skills_config.rs#L19-L29,L99-L135`.
- Only the **User** and **SessionFlags** config layers are read for these rules, so a project `.codex/config.toml` cannot disable a single skill: `skills_config.rs#L158-L195`.
- App-server RPCs exist for this:
  - `skills/list` (params `cwds`, `forceReload`) returns entries with `name`, `description`, `interface` (with local icon paths and remote `iconSmallUrl`/`iconLargeUrl`), `scope` (`user|repo|system|admin`) and `enabled`.
  - `skills/config/write {path|name, enabled}` returns `effectiveEnabled`.
  - `skills/changed` is a notification sent when watched skill files change.
  - Sources: `CX/codex-rs/app-server-protocol/src/protocol/common.rs#L924-L929,L1072-L1075,L2029` and `…/v2/plugin.rs#L18-L29,L461-L512,L939-L955,L1055-L1063`. The file watcher is in `CX/codex-rs/app-server/src/skills_watcher.rs`.
- The docs say to "Restart Codex after changing configuration" (learn.chatgpt.com page above).

### Installer and catalog
- The `skill-installer` system skill is Python scripts that the agent runs:
  - Listing uses the GitHub contents API on `openai/skills/skills/.curated` (`…/skill-installer/scripts/github_utils.py#L20-L21`).
  - Downloads use `codeload.github.com/<o>/<r>/zip/<ref>`, falling back to a git sparse checkout (`install-skill-from-github.py#L81-L82,L131`).
  - Skills install into `$CODEX_HOME/skills/<name>` and the installer "Aborts if the destination skill directory already exists". There is **no update command and no version record** (`…/skill-installer/SKILL.md#L10,L43-L58`).
- The catalog is the openai/skills repo. It has three folders, `skills/.curated` (39 skills), `.system` and `.experimental`, all one folder per skill, with no index file (https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills). All 44 of its SKILL.md files have `agents/openai.yaml`.
- Plugins, a separate system, do have updates:
  - Codex syncs `github.com/openai/plugins` into `$CODEX_HOME/.tmp/plugins`, records the commit in `.tmp/plugins.sha`, and skips the fetch when `git ls-remote` returns the same SHA: `CX/codex-rs/core-plugins/src/startup_sync.rs#L26-L34,L185-L229`.
  - Codex also reads Claude- and Cursor-style marketplaces: `.agents/plugins/marketplace.json`, `.claude-plugin/marketplace.json` and `.cursor-plugin/marketplace.json` (`CX/codex-rs/core-plugins/src/marketplace.rs#L20-L25`), and accepts `.claude-plugin/plugin.json` manifests (`manifest.rs#L685`).

### Desktop app Skills page
- The desktop app is **not** in openai/codex. The repo contains only `codex-cli`, `codex-rs` and `sdk`.
- The docs say you open **Skills** in the sidebar and that skills are labelled Personal and System.
- **Unverified (inferred):** that the page uses `skills/list`, that Personal maps to `scope: user` and System to `scope: system`, and that icons come from `interface.icon_*` or `icon_*_url`. The docs do not describe an "Add" action.

## 2. Claude Code

- Skill locations: `CC/skills.md` (table near L155-165).
  - Enterprise: the managed settings folder.
  - Personal: `~/.claude/skills/<name>/SKILL.md`.
  - Project: `.claude/skills/`, loaded from the cwd up to the repo root.
  - Nested: `<subdir>/.claude/skills`.
  - `--add-dir` folders.
  - Plugins: `<plugin>/skills/`, namespaced `plugin:skill`.
  - claude.ai: synced into `~/.claude/skills/synced/`.
- The docs list **no** `.agents/skills` path, so Claude Code needs its own copy or link.
- Precedence is enterprise, then personal, then project; plugin skills are namespaced (L211).
- Symlinked skill folders are followed, and a target that several locations point at loads once (L168).
- Live reload: SKILL.md edits under `~/.claude/skills` and the project `.claude/skills` apply in the running session. A top-level skills folder created mid-session needs `/reload-skills` (L318-322).
- Frontmatter follows the Agent Skills standard plus Claude extensions: `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `hooks`, `paths`, `shell` (L397+).
  - Only `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools` are portable to claude.ai and the API.
- Disabling a skill:
  - The `skillOverrides` setting maps a skill name to `"on" | "name-only" | "user-invocable-only" | "off"`; a missing entry means `"on"`. `/skills` writes it to `.claude/settings.local.json`. It does **not** apply to plugin skills (L911-941).
  - Also possible: `disableBundledSkills`, permission rules (`Skill(name)`), and the frontmatter flags (L29, L332-334).
- Plugin marketplaces:
  - A marketplace is a repo with `.claude-plugin/marketplace.json` containing `name`, `owner` and `plugins[]` (`CC/plugin-marketplaces.md#L9,L48`).
  - Added with `/plugin marketplace add owner/repo[#ref]`, a git URL, a local path, or an https `marketplace.json` (`CC/discover-plugins.md#L192-L199`).
- Plugin updates:
  - A user gets a new copy only when the plugin's computed **version** changes. The version comes from `plugin.json`, then from the marketplace entry. If `version` is omitted, the commit SHA is used. Bumping is required: "If you set "version": "1.0.0" and push new commits without changing it, users don't receive them." (`CC/plugins/host-marketplace.md#L186-L195,L248`)
  - Auto-update is on by default only for official marketplaces. In a session, after a random delay of up to 10 minutes, Claude Code refreshes those marketplaces and prints "Plugin updated… Run /reload-plugins" (`CC/discover-plugins.md#L343-L352`, `CC/plugins/loading.md#L350-L360`).
  - Copies live under `~/.claude/plugins/` (cache), `loading.md#L191`.
- Seen on this machine: mattpocock skills are installed **twice**, as the `mattpocock-skills` plugin and as `~/.claude/skills/*` symlinks. The session lists both `tdd` and `mattpocock-skills:tdd`.

## 3. Other agents Zaki runs

All of these read SKILL.md folders. `~/.agents/skills` is the shared user folder for every agent below except Claude Code (and Cursor's own sync).

| Agent | User folders | Project folders | Per-skill off switch | Source |
|---|---|---|---|---|
| Codex | `~/.agents/skills`, `~/.codex/skills` (deprecated) | `.agents/skills` (root→cwd), `.codex/skills` | `[[skills.config]]` in `~/.codex/config.toml` | §1 |
| Claude Code | `~/.claude/skills` only | `.claude/skills` | `skillOverrides` | §2 |
| Pi | `~/.pi/agent/skills`, `~/.agents/skills` | `.pi/skills`, `.agents/skills` (cwd→repo root) | none per skill: `disable-model-invocation`, or `!`/`-path` exclusions in `skills` setting | [skills.md L57-61](https://github.com/badlogic/pi-mono/blob/d9af3d73afb3b2c02c7a833d7ca9f3875e5fff6e/packages/coding-agent/docs/skills.md), [settings.md L157-162](https://github.com/badlogic/pi-mono/blob/d9af3d73afb3b2c02c7a833d7ca9f3875e5fff6e/packages/coding-agent/docs/settings.md), `src/core/skills.ts#L458-L459`, `src/config.ts#L606,L630-L636` |
| Gemini CLI | `~/.gemini/skills`, `~/.agents/skills` (alias wins in a tier) | `.gemini/skills`, `.agents/skills` | `skills.disabled` list in settings.json; `/skills disable <name>` | [docs/cli/skills.md L35-56,L92-95](https://github.com/google-gemini/gemini-cli/blob/3fd7d263466b9e5d30b2da1ebf85dae956a0fb86/docs/cli/skills.md), `packages/cli/src/config/settingsSchema.ts#L2516-L2541` |
| OpenCode | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills` | `.opencode/skills`, `.claude/skills`, `.agents/skills` (walks up) | `permission.skill` patterns: `"deny"` hides it | [skills.mdx L16-30,L125-145](https://github.com/sst/opencode/blob/386229c1abe6b2014d0e88bb3ce29fa8ca1b1786/packages/web/src/content/docs/skills.mdx) |
| Cursor | `~/.agents/skills`, `~/.cursor/skills`; also `~/.claude/skills`, `~/.codex/skills` | `.agents/skills`, `.cursor/skills` (nested), `.claude/skills`, `.codex/skills` | only `disable-model-invocation` | https://cursor.com/docs/context/skills (closed source, docs only) |
| Amp | `~/.config/agents/skills`, `~/.agents/skills`, `~/.config/amp/skills`, `~/.claude/skills`, `~/.claude/plugins/cache` | `.agents/skills`, `.claude/skills` (walks up) | none per skill; whole sources only (`amp.skills.disableClaudeCodeSkills`, `…disableGlobalAgentsSkills`) | https://ampcode.com/docs/customize/skills (closed source, docs only) |

- Agent Skills spec (https://agentskills.io/specification):
  - Required: `name` (1-64 characters, `a-z0-9-`, no leading, trailing or double hyphens, **must match the folder name**) and `description` (1-1024 characters).
  - Optional: `license`, `compatibility` (≤500 characters), `metadata` (string→string map, for example `version: "1.0"`), `allowed-tools` (experimental).
  - Recommended subfolders: `scripts/`, `references/`, `assets/`.
  - The spec defines **no install locations and no versioning**. `metadata.version` appears only as an example.
- vercel-labs/skills keeps a table of about 80 agents' folders (`VS/src/agents.ts`). Its entries for Codex, Pi, OpenCode, Gemini and Cursor match the sources above, which supports the table. Its Amp global folder is `~/.config/agents/skills` (L95-99).
- Not checked: Copilot, Grok, Antigravity, Kimi, Kiro, Hermes, Crush and the other Zaki agents. `VS/src/agents.ts` lists folders for them (secondary source, **unverified**).

## 4. Existing cross-agent installers

### `npx skills` / skills.sh (vercel-labs/skills; this machine uses it)
- Install modes (`VS/src/installer.ts#L36-L40`):
  - `symlink` (default): copy into the canonical `.agents/skills/<name>` (or `~/.agents/skills`), then symlink each agent's folder to it.
  - `copy`: a copy in each agent folder.
  - `link`: symlink the canonical folder to the source.
- "Universal" agents, the ones that read `.agents/skills` themselves, get no extra link (L150-165).
- On Windows it makes **junctions** with absolute targets (L292-295). If linking fails it falls back to copying (L231-232).
- This machine's layout matches: `~/.claude/skills/*` are relative symlinks to `../../.agents/skills/*`.
- Global lock: `~/.agents/.skill-lock.json` (or `$XDG_STATE_HOME/skills/.skill-lock.json`), schema `version: 3` (`VS/src/skill-lock.ts#L7-L8,L66-L70`). Each entry stores:
  - `source` (`owner/repo`), `sourceType`, `sourceUrl`, `ref?`, `skillPath` (path to SKILL.md)
  - **`skillFolderHash` = the GitHub tree SHA of the skill folder**
  - `installedAt`, `updatedAt`, `pluginName?`, `installMode?` (L13-44)
- Project lock: `skills-lock.json`, which is checked in. It uses a **sha256 of the files on disk** (`computedHash`) instead of the tree SHA (`VS/src/local-lock.ts#L6,L38-L42`).
- Update check (`VS/src/update.ts#L612-L722`, `VS/src/blob.ts#L113-L135,L178-L215`):
  - Group the locked skills by source and ref.
  - Make one `GET /repos/{o}/{r}/git/trees/{ref}?recursive=1` per source (using `gh api` when available for the auth quota).
  - For each skill, compare the folder's tree SHA with `skillFolderHash`. A difference means an update.
  - If the API is unavailable, fall back to `git clone`.
- This machine already shows drift: the locked `code-review` is `7a2057d…` while upstream is `a8ef561…`, and the locked `tdd` is `423f3cc…` while upstream is `667dbdd…` (checked today with `gh api`). Both were last updated 2026-08-06.
- Catalog and search:
  - There is no Git index. `skills find` calls `https://skills.sh/api/search?q=…` and gets `{skills:[{id,name,installs,source}]}` (`VS/src/find.ts#L19,L96-L120`). It is undocumented; stability is **unverified**.
  - Sites can publish `/.well-known/agent-skills/index.json`. Schema `https://schemas.agentskills.io/discovery/0.2.0/schema.json`, entries `{name,type:"skill-md"|"archive",description,url,digest}` (`VS/src/providers/wellknown.ts#L10,L38-L52`).
  - The CLI sends telemetry to `skills.sh/tele` (`VS/src/telemetry.ts#L3-L4`).

### openskills (numman-ali)
- Installs into `.claude/skills`, or `.agent/skills` with `--universal`, and writes a skills list into AGENTS.md (`sync`) (README L37, L155-188).
- Keeps a per-skill `.openskills.json` with `{source, sourceType, repoUrl, subpath, installedAt}` and **no hash**. `update` simply re-clones (`git clone --depth 1`) and overwrites (`src/utils/skill-metadata.ts#L4-L15`, `src/commands/update.ts#L97`).

## 5. Catalog sources

- **anthropics/skills**:
  - One folder per skill under `skills/` (20 skills).
  - `.claude-plugin/marketplace.json` groups them into plugins (`document-skills`, `example-skills`, `claude-api`, …) with `skills: ["./skills/xlsx", …]`.
  - No `agents/openai.yaml`. https://github.com/anthropics/skills/blob/ca45fc496a3436251f191354091d557da31c15b5/.claude-plugin/marketplace.json
- **mattpocock/skills**:
  - Folders are grouped by category: `skills/{engineering,productivity,misc,in-progress,deprecated}/<skill>` (39 SKILL.md).
  - `.claude-plugin/marketplace.json` has one plugin. `.claude-plugin/plugin.json` (`version: 1.3.2`) lists the **published** skills explicitly, leaving out `in-progress`.
  - 38 of the 39 skills have `agents/openai.yaml` (display name and short description).
  - https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d
- **openai/skills**: `skills/.curated|.system|.experimental/<skill>`, no index, every skill has `openai.yaml` (§1).
- Others checked with `gh api`:
  - `obra/superpowers`: 15 SKILL.md, with `.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`.
  - `vercel-labs/agent-skills`: 9 SKILL.md, no index.
- **Can a catalog come from the repo tree alone?** Partly.
  - One recursive tree call finds every `*/SKILL.md` and each folder's tree SHA.
  - But names and descriptions need one SKILL.md fetch per skill.
  - Scanning cannot tell published skills from drafts (mattpocock `in-progress`, `deprecated`) without the repo's own manifest or a curated list.
- GitHub API facts:
  - Unauthenticated: **60 requests/hour**. Authenticated: 5,000/hour. Responses carry `x-ratelimit-*` headers (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
  - Conditional requests (`If-None-Match` with an ETag, `If-Modified-Since`) return `304`. A 304 doesn't count against the limit **only if the request was "correctly authorized with an Authorization header"** (https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
  - Trees API: `GET /repos/{o}/{r}/git/trees/{sha-or-ref}?recursive=1`, limited to 100,000 entries or 7 MB (`truncated` flag). Each `tree[]` entry has `path`, `type` and `sha`; a `type: tree` entry's `sha` is the folder hash (https://docs.github.com/en/rest/git/trees).
  - `GET /repos/{o}/{r}/commits/{ref}` with `Accept: application/vnd.github.sha` returns only the commit SHA; tested, ETag = the SHA. `GET …/commits?path=<folder>&per_page=1` gives the last commit that touched a folder (https://docs.github.com/en/rest/commits/commits).
  - `git ls-remote <url> HEAD` uses no REST quota. Codex uses it for exactly this check (§1). Whether raw.githubusercontent.com and codeload.github.com have their own limits is **unverified**: GitHub's docs here don't give numbers for them.

---

## Recommendation (opinion, not cited fact)

### Where the catalog lives
| Option | UX | DX | Problems |
|---|---|---|---|
| A. JSON built into `defaults/` | Instant, works offline | PR to Zaki | New skills wait for a release |
| B. Curated JSON in a Zaki-owned GitHub repo, fetched with ETag | Fresh, one request | PR to the catalog repo, no release | Needs a network round trip and a host |
| C. Scan upstream repos live | Always fresh | No curation work | Many API calls, shows drafts, 60/h unauthenticated |
| D. skills.sh search API | Huge reach | None | Uncurated, undocumented, third-party telemetry |
| E. Reuse `marketplace.json` | Native for Claude and Codex | None | Lists plugins, not skills; only some repos have it |

**Pick B, with A as fallback.** A small **source list** is kept by hand (repo, ref, include globs such as `skills/engineering/*`, excludes). A scheduled job resolves it into **`catalog.json`**. Each entry is `{id: "owner/repo/path", name, description, shortDescription, displayName, icon (raw URL from openai.yaml), repo, path, ref, commit, treeSha}`.
- The client makes **one conditional GET** of `catalog.json` and learns, in one go, the full browse list and the latest `treeSha` of every catalog skill. That is the whole update check, with no per-repo API calls and no rate-limit problems.
- A copy of `catalog.json` ships in `defaults/` so the page works offline and on first start.
- Hosting: the GitHub repo's raw URL or the existing R2 bucket behind `distribution/worker`. Generating with Actions costs minutes; a cheap job (e.g. every 6 h) is fine. Actions minute rules for public versus private repos are **unverified** here.
- Skills added "by URL" outside the catalog (the "Add" menu) are checked directly: `git ls-remote` first, then one tree call only when the commit changed.

### Install layout: one copy for every agent
- **Canonical store: `~/.config/zaki/skills/<name>/`**. Mods can write there with `fs/promises` (writes are limited to `~/.config/zaki`, per `defaults/AGENTS.md` "Other built-ins"), and Zaki owns it outright.
- **Links**: `~/.agents/skills/<name>` covers Codex, Pi, Gemini, OpenCode, Cursor and Amp, and `~/.claude/skills/<name>` covers Claude Code. Two links reach all seven agents.
- Before linking, check whether the target already exists and who owns it: a vercel lock entry, a real folder, or a plugin copy. Never overwrite something Zaki didn't make.
- Windows: use **junctions** (`mklink /J`, absolute target). They need no admin rights or Developer Mode. Unprivileged *symlinks* need Developer Mode, per https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw. Fall back to a copy and keep the copy in sync on update. Whether every agent follows junctions is **unverified**; test it on Windows.
- Remote machines (spaces with `machine`): skills live per machine, so install with `exec(..., {on})` there. `fs/promises` works only locally.
- **Enable/disable = add/remove the links**; the store copy stays. This works the same in every agent and needs no edits to agent config files. Agents that reload live (Claude Code, Codex) pick it up; Pi needs `/reload` and Gemini `/skills reload`.
  - Optional later: a per-agent toggle through each agent's own setting (Codex `[[skills.config]]`, Claude `skillOverrides`, Gemini `skills.disabled`, OpenCode `permission.skill`). Pi, Cursor and Amp have no per-skill off switch, so per-agent control there would mean per-agent links.

### Updates
- The lock lives in `~/.config/zaki` (mod storage). Each skill records `{id, repo, path, ref, commit, treeSha, localHash, installedAt, updatedAt, links[]}`. `localHash` is a hash of the installed files, taken at install time.
- **Check**: on start and every 6 h (`cx.timer.every`), conditionally GET `catalog.json`. For URL-added skills, run `git ls-remote` and then a tree call. An update exists when `treeSha` differs.
- **Notify**: a toast ("3 skill updates"), a badge on the page, and an "Update" or "Update all" button on each card. Optionally show the upstream commits (`commits?path=`).
- **Apply**: download `codeload…/tar.gz/<commit>` once per repo and extract the folder to `<name>.new`. Then swap: rename the current folder to `.old`, rename `.new` into place, delete `.old`. Every agent sees the new version at once because all their links point at one path. A commit-pinned download avoids moving refs.
- **Local edits**: before updating, hash the store copy. If it differs from `localHash`, the skill was edited: offer "Keep mine" (moves it to a personal skill and stops updates, like Zaki's shipped mods), "Replace" and "Show diff". Never overwrite silently.
- Interop: adopt existing `npx skills` installs (read `~/.agents/.skill-lock.json`: same `skillFolderHash` idea), offer "manage with Zaki", and don't both write the same folder.

### Mod or core (per AGENTS.md's three questions)
- 1) Does the app act on skills? No, agents read the files. 2) Can only the app see it? No. 3) Can't mods do it? Mods have `fetch`, `exec`, `fs/promises`, `watchFolder`, `cx.timer.every`, `notify`, `tab.new {mod}` and overlays (`defaults/herdr.d.ts`, `defaults/AGENTS.md`). **All three look like "no", so it's a mod.**
- Possible friction to flag rather than fix:
  - `exec` has a 30 s limit and 8 MiB of output, which matters for large repo downloads.
  - `readTextFile` reads at most 1 MiB.
  - Binary icons: whether gpui-kit can show an image file from a path is **unverified**.
  - Writing outside `~/.config/zaki` (`~/.agents`, `~/.claude`) has to go through `exec`.
- `defaults/AGENTS.md` and probably `src/SKILL.md` need updating with any new command or setting.

## Open questions for the maintainer
1. Where should the catalog be hosted: a new GitHub repo, the Zaki repo (`catalog/`), or the R2 Worker? Who is allowed to add sources?
2. Canonical store: `~/.config/zaki/skills` (Zaki-owned) or `~/.agents/skills` itself, like `npx skills`? Should Zaki adopt the vercel lock or ignore it?
3. What are "Personal" and "System" in Zaki? One option: Personal is what the user installed or wrote; System is what agents bundle (Codex `.system`, Claude bundled) plus skills Zaki ships (for example a `zaki` skill from `zaki --skill`).
4. Scope: user-level only, or project `.agents/skills` installs too, which would need per-project locks?
5. Auto-update quietly, or always ask? How should edited skills be treated?
6. Remote machines: install on each machine, or only the local one?
7. Plugin-provided skills (Claude and Codex plugins): only show them as read-only cards, and detect duplicates (this machine has both `tdd` and `mattpocock-skills:tdd`)?
8. Per-agent enable/disable in v1, or only all agents at once?
