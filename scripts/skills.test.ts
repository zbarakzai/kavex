import { test, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync, readdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

// skills.js for real: its sh scripts and curl run against a scratch home. Downloads come from a
// folder standing in for raw.githubusercontent.com (curl reads file:// the same way), and the
// catalog from a stand-in fetch. Set SKILLS_LIVE=1 to also install from the real catalog.

let root = "", remote = "", catalog: any = null, lists: Record<string, any> = {}, state: { shared: Record<string, any>; toasts: any[] };
const RAW = "https://raw.githubusercontent.com/";
const live = process.env.SKILLS_LIVE === "1";

mock.module("herdr", () => ({
  appHome: () => join(root, "app"),
  home: () => join(root, "home"),
  window: () => ({ platform: process.platform === "darwin" ? "macos" : "linux" }),
  shared: (k: string) => state.shared[k],
  setShared: (k: string, v: any) => { state.shared[k] = v; },
  notify: (n: any) => { state.toasts.push(n); return "n"; },
  readTextFile: async (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  writeTextFile: async (path: string, text: string, expected: string | null) => {
    const now = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (now !== expected) throw new Error("stale");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return null;
  },
  exec: async (command: string, args: string[] = []) => {
    const argv = live ? args : args.map((a) => (a.startsWith(RAW) ? `file://${remote}/${a.slice(RAW.length)}` : a));
    const p = Bun.spawn([command, ...argv], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(root, "home") } });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, stdout, stderr };
  },
}));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, options?: any) => {
  if (!live && String(url).includes("zaki-skills/main/catalog.json")) return new Response(catalog ? JSON.stringify(catalog) : "nope", { status: catalog ? 200 : 503 });
  const list = !live && /zaki-skills\/main\/files\/(.+)\.json$/.exec(String(url));
  if (list) return new Response(JSON.stringify(lists[list[1]] ?? {}), { status: lists[list[1]] ? 200 : 404 });
  return realFetch(url, options);
}) as any;

const skills = await import("../defaults/mods/workspace-chrome/skills.js");

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const app = (...p: string[]) => join(root, "app", ...p);
const homeOf = (...p: string[]) => join(root, "home", ...p);
const lock = () => JSON.parse(readFileSync(app("skills.json"), "utf8"));

// A skill as GitHub would serve it at one commit, and its catalog entry.
function publish(name: string, files: Record<string, string | Uint8Array>, { repo = "someone/skills", version = "1" } = {}) {
  const commit = sha(`${repo}@${name}@${version}`), path = `skills/${name}`;
  for (const [file, content] of Object.entries(files)) {
    const at = join(remote, repo, commit, path, file);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, content);
  }
  const tree = sha(JSON.stringify(Object.entries(files).map(([f, c]) => [f, String(c)])));
  const listed = Object.entries(files).map(([file, c]) => ({ path: file, size: typeof c === "string" ? c.length : c.byteLength }));
  (lists[repo] ??= { repo, commit, skills: {} }).skills[path] = { commit, tree, files: listed };
  return {
    id: `${repo}/${path}`, name, title: name.toUpperCase(), short: `${name} in short`, description: `All about ${name}.`, repo, path, ref: "main", commit, tree,
    files: Object.entries(files).map(([file, c]) => ({ path: file, size: typeof c === "string" ? c.length : c.byteLength, sha: sha(String(c)) })),
  };
}
// As catalog.json lists it: no files, they're in files/<repo>.json.
const listed = ({ files, ...entry }: any) => entry;
const skillMd = (name: string, extra = "") => `---\nname: ${name}\ndescription: Use ${name} when asked.\n---\n\n# ${name}\n${extra}`;
const linkOf = (dir: string, name: string) => join(homeOf(dir, "skills"), name);
const linked = (dir: string, name: string) => existsSync(linkOf(dir, name)) && lstatSync(linkOf(dir, name)).isSymbolicLink() && readlinkSync(linkOf(dir, name)) === app("skills", name);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kavex-skills-")));
  remote = join(root, "remote");
  mkdirSync(homeOf(), { recursive: true });
  mkdirSync(app(), { recursive: true });
  catalog = null;
  lists = {};
  state = { shared: {}, toasts: [] };
});

test("installing copies the skill once and links it into every agent's folder", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  const tdd = publish("tdd", { "SKILL.md": skillMd("tdd"), "refs/tests.md": "how to test", "assets/logo.png": png });
  await skills.install(tdd);
  expect(readFileSync(app("skills/tdd/SKILL.md"), "utf8")).toBe(skillMd("tdd"));
  expect(new Uint8Array(readFileSync(app("skills/tdd/assets/logo.png")))).toEqual(png);
  expect(linked(".claude", "tdd")).toBe(true);
  expect(linked(".agents", "tdd")).toBe(true);
  expect(readFileSync(homeOf(".claude/skills/tdd/refs/tests.md"), "utf8")).toBe("how to test");
  const s = lock().skills.tdd;
  expect([s.id, s.commit, s.tree, s.enabled, s.source]).toEqual([tdd.id, tdd.commit, tdd.tree, true, "catalog"]);
  expect(s.hash).toMatch(/^[0-9a-f]{16}$/);
  expect(state.shared["skills.busy"]).toEqual({});
  expect(readdirSync(app("skills")).filter((n) => n.startsWith("."))).toEqual([]);
});

test("a catalog entry gets its files from its repo's list, and one gone from it can't install", async () => {
  const tdd = publish("tdd", { "SKILL.md": skillMd("tdd"), "a/b.md": "deep" });
  await skills.install(listed(tdd));
  expect(readFileSync(homeOf(".agents/skills/tdd/a/b.md"), "utf8")).toBe("deep");
  const gone = listed(publish("gone", { "SKILL.md": skillMd("gone") }));
  delete lists[gone.repo].skills[gone.path];
  await expect(skills.install(gone)).rejects.toThrow("isn't in the list any more");
  expect(existsSync(linkOf(".claude", "gone"))).toBe(false);
});

test("off removes only the links, and on puts them back", async () => {
  await skills.install(publish("grill", { "SKILL.md": skillMd("grill") }));
  await skills.setEnabled("grill", false);
  expect(existsSync(linkOf(".claude", "grill")) || existsSync(linkOf(".agents", "grill"))).toBe(false);
  expect(existsSync(app("skills/grill/SKILL.md"))).toBe(true);
  expect(lock().skills.grill.enabled).toBe(false);
  await skills.setEnabled("grill", true);
  expect(linked(".claude", "grill") && linked(".agents", "grill")).toBe(true);
});

test("a skill of the person's own with that name is never touched, unless they say replace, and then it's kept aside", async () => {
  mkdirSync(homeOf(".claude/skills/pdf"), { recursive: true });
  writeFileSync(homeOf(".claude/skills/pdf/SKILL.md"), "mine");
  const pdf = publish("pdf", { "SKILL.md": skillMd("pdf") });
  await expect(skills.install(pdf)).rejects.toThrow("~/.claude/skills already has a skill named pdf");
  expect(readFileSync(homeOf(".claude/skills/pdf/SKILL.md"), "utf8")).toBe("mine");
  expect(existsSync(app("skills/pdf"))).toBe(false);
  expect(existsSync(linkOf(".agents", "pdf"))).toBe(false);
  expect(existsSync(app("skills.json"))).toBe(false);

  await skills.install(pdf, { replace: true });
  expect(linked(".claude", "pdf") && linked(".agents", "pdf")).toBe(true);
  const kept = readdirSync(app("skills-backup"));
  expect(kept.length).toBe(1);
  expect(readFileSync(app("skills-backup", kept[0], "claude", "SKILL.md"), "utf8")).toBe("mine");
});

test("a second skill with a name that's taken is refused", async () => {
  await skills.install(publish("pdf", { "SKILL.md": skillMd("pdf") }));
  await expect(skills.install(publish("pdf", { "SKILL.md": skillMd("pdf") }, { repo: "other/skills" }))).rejects.toThrow("already");
});

test("a check finds a new version, says so once, and updating reaches every agent through the same links", async () => {
  const v1 = publish("tdd", { "SKILL.md": skillMd("tdd", "v1") });
  catalog = { version: 1, generated: "2026-11-05T10:00:00Z", skills: [v1] };
  await skills.install({ ...v1, seen: catalog.generated });
  await skills.checkSkills();
  expect(state.shared["skills.updates"]).toEqual([]);
  expect(state.toasts).toEqual([]);

  const v2 = publish("tdd", { "SKILL.md": skillMd("tdd", "v2"), "new.md": "added" }, { version: "2" });
  catalog = { version: 1, generated: "2026-11-05T16:00:00Z", skills: [listed(v2)] };
  await skills.checkSkills();
  expect(state.shared["skills.updates"].map((u: any) => [u.name, u.tree])).toEqual([["tdd", v2.tree]]);
  expect(state.toasts.length).toBe(1);
  expect(state.toasts[0]).toMatchObject({ title: "TDD has an update", action: { name: "mod.open", args: { name: "customize" } } });
  await skills.checkSkills();
  expect(state.toasts.length).toBe(1);

  await skills.update("tdd");
  expect(readFileSync(homeOf(".claude/skills/tdd/SKILL.md"), "utf8")).toContain("v2");
  expect(readFileSync(homeOf(".agents/skills/tdd/new.md"), "utf8")).toBe("added");
  expect([lock().skills.tdd.commit, lock().skills.tdd.tree]).toEqual([v2.commit, v2.tree]);
  expect(state.shared["skills.updates"]).toEqual([]);
  await skills.checkSkills();
  expect(state.shared["skills.updates"]).toEqual([]);
});

test("an older list never offers a step back", async () => {
  const v2 = publish("tdd", { "SKILL.md": skillMd("tdd", "v2") }, { version: "2" });
  await skills.install({ ...v2, seen: "2026-11-05T16:00:00Z" });
  catalog = { version: 1, generated: "2026-11-01T00:00:00Z", skills: [publish("tdd", { "SKILL.md": skillMd("tdd", "v1") })] };
  await skills.checkSkills();
  expect(state.shared["skills.updates"]).toEqual([]);
});

test("a skill the person changed isn't replaced: they replace it or keep theirs", async () => {
  const v1 = publish("tdd", { "SKILL.md": skillMd("tdd", "v1") });
  await skills.install(v1);
  writeFileSync(homeOf(".claude/skills/tdd/SKILL.md"), "my own notes");
  const v2 = publish("tdd", { "SKILL.md": skillMd("tdd", "v2") }, { version: "2" });
  catalog = { version: 1, generated: "2026-11-06T00:00:00Z", skills: [v2] };
  await skills.checkSkills();
  const error = await skills.update("tdd").catch((e: any) => e);
  expect(error.edited).toBe(true);
  expect(readFileSync(app("skills/tdd/SKILL.md"), "utf8")).toBe("my own notes");

  await skills.hold("tdd");
  expect(lock().skills.tdd.held).toBe(v2.tree);
  await skills.checkSkills();
  expect(state.shared["skills.updates"]).toEqual([]);

  const v3 = publish("tdd", { "SKILL.md": skillMd("tdd", "v3") }, { version: "3" });
  catalog = { version: 1, generated: "2026-11-07T00:00:00Z", skills: [v3] };
  await skills.checkSkills();
  expect(state.shared["skills.updates"].length).toBe(1);
  await skills.update("tdd", { force: true });
  expect(readFileSync(homeOf(".agents/skills/tdd/SKILL.md"), "utf8")).toContain("v3");
});

test("updating by themselves updates the unchanged ones and tells once", async () => {
  const a1 = publish("a", { "SKILL.md": skillMd("a", "1") }), b1 = publish("b", { "SKILL.md": skillMd("b", "1") });
  await skills.install(a1);
  await skills.install(b1);
  writeFileSync(app("skills/b/SKILL.md"), "changed");
  state.shared["skills.auto"] = true;
  catalog = { version: 1, generated: "2026-11-06T00:00:00Z", skills: [publish("a", { "SKILL.md": skillMd("a", "2") }, { version: "2" }), publish("b", { "SKILL.md": skillMd("b", "2") }, { version: "2" })] };
  await skills.checkSkills();
  expect(readFileSync(app("skills/a/SKILL.md"), "utf8")).toContain("2");
  expect(readFileSync(app("skills/b/SKILL.md"), "utf8")).toBe("changed");
  expect(state.toasts.map((t: any) => t.title)).toEqual(["A was updated", "B has an update"]);
});

test("checks are off when the person turns them off, and a failed list keeps what was there", async () => {
  state.shared["skills.checks"] = false;
  await skills.checkSkills();
  expect(state.shared["skills.check"]).toBeUndefined();
  state.shared["skills.checks"] = true;
  catalog = null;
  await skills.checkSkills();
  expect(state.shared["skills.check"].error).toContain("503");
  expect(state.shared["skills.check"].running).toBeUndefined();
});

test("a check run within the window doesn't run again", async () => {
  catalog = { version: 1, generated: "x", skills: [] };
  await skills.checkSkills({ within: skills.EVERY });
  const at = state.shared["skills.check"].at;
  catalog = null;
  await skills.checkSkills({ within: skills.EVERY });
  expect(state.shared["skills.check"]).toEqual({ at, error: null });
});

test("removing deletes Kavex's copy and its links, and nothing else", async () => {
  await skills.install(publish("tdd", { "SKILL.md": skillMd("tdd") }));
  mkdirSync(homeOf(".agents/skills/other"), { recursive: true });
  await skills.remove("tdd");
  expect(existsSync(app("skills/tdd")) || existsSync(linkOf(".claude", "tdd")) || existsSync(linkOf(".agents", "tdd"))).toBe(false);
  expect(existsSync(homeOf(".agents/skills/other"))).toBe(true);
  expect(lock().skills).toEqual({});
});

test("a link someone else pointed elsewhere is left alone on remove", async () => {
  await skills.install(publish("tdd", { "SKILL.md": skillMd("tdd") }));
  await skills.setEnabled("tdd", false);
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  symlinkSync(join(root, "elsewhere"), linkOf(".claude", "tdd"));
  await skills.remove("tdd");
  expect(readlinkSync(linkOf(".claude", "tdd"))).toBe(join(root, "elsewhere"));
});

test("a folder of the person's own is linked where it is and never deleted", async () => {
  const mine = join(root, "work", "my-skill");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "SKILL.md"), skillMd("mine"));
  expect(await skills.addFolder(mine)).toBe("mine");
  expect(readlinkSync(linkOf(".claude", "mine"))).toBe(mine);
  expect(readlinkSync(linkOf(".agents", "mine"))).toBe(mine);
  await expect(skills.update("mine", { entry: publish("mine", { "SKILL.md": "x" }) })).rejects.toThrow("folder of yours");
  await skills.remove("mine");
  expect(existsSync(linkOf(".claude", "mine"))).toBe(false);
  expect(readFileSync(join(mine, "SKILL.md"), "utf8")).toBe(skillMd("mine"));
});

test("a download that fails leaves nothing behind", async () => {
  const broken = publish("broken", { "SKILL.md": skillMd("broken") });
  broken.files.push({ path: "missing.md", size: 1, sha: "x" });
  await expect(skills.install(broken)).rejects.toThrow("Couldn't download");
  expect(existsSync(app("skills")) ? readdirSync(app("skills")) : []).toEqual([]);
  expect(existsSync(linkOf(".claude", "broken"))).toBe(false);
  expect(state.shared["skills.busy"]).toEqual({});
});

test("names and paths that could escape the folders are refused before anything runs", () => {
  const ok = publish("ok", { "SKILL.md": skillMd("ok") });
  for (const bad of [{ ...ok, name: "../x" }, { ...ok, name: ".hidden" }, { ...ok, files: [...ok.files, { path: "../../evil", size: 1, sha: "" }] }, { ...ok, files: [{ path: "/etc/x", size: 1, sha: "" }] }, { ...ok, commit: "main" }, { ...ok, files: [{ path: "a.md", size: 1, sha: "" }] }])
    expect(() => skills.check(bad)).toThrow();
  expect(() => skills.check(ok)).not.toThrow();
});

test("the page sees Kavex's skills, the person's own and the agents' own", async () => {
  await skills.install(publish("tdd", { "SKILL.md": skillMd("tdd") }));
  for (const [dir, name] of [[".agents/skills", "theirs"], [".codex/skills/.system", "imagegen"], ["plugins/x/skills", "from-plugin"]]) {
    mkdirSync(homeOf(dir, name), { recursive: true });
    writeFileSync(homeOf(dir, name, "SKILL.md"), skillMd(name));
  }
  symlinkSync(homeOf(".agents/skills/theirs"), linkOf(".claude", "theirs"));
  mkdirSync(homeOf(".claude/plugins"), { recursive: true });
  writeFileSync(homeOf(".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "x@market": [{ installPath: homeOf("plugins/x") }] } }));
  mkdirSync(homeOf(".agents/skills/not-a-skill"), { recursive: true });
  const seen = await skills.scan();
  expect(seen.linked.tdd.sort()).toEqual(["agents", "claude"]);
  expect(seen.personal.map((p: any) => [p.name, p.places.sort(), p.short])).toEqual([["theirs", ["~/.agents/skills", "~/.claude/skills"], "Use theirs when asked."]]);
  expect(seen.system.map((s: any) => [s.name, s.from]).sort()).toEqual([["from-plugin", "x plugin"], ["imagegen", "Codex"]]);
});

test("GitHub links: a folder, a repo, a file; anything else isn't one", () => {
  expect(skills.parseLink("https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd")).toEqual({ repo: "mattpocock/skills", ref: "main", path: "skills/engineering/tdd" });
  expect(skills.parseLink("github.com/anthropics/skills")).toEqual({ repo: "anthropics/skills", ref: "HEAD", path: "" });
  expect(skills.parseLink("https://github.com/o/r/blob/v2/x/SKILL.md")).toEqual({ repo: "o/r", ref: "v2", path: "x" });
  expect(skills.parseLink("https://gitlab.com/o/r")).toBeNull();
});

test("frontmatter: plain, quoted and folded descriptions", () => {
  expect(skills.frontmatter('---\nname: a\ndescription: "Say \\"hi\\"."\n---\nbody')).toEqual({ name: "a", description: 'Say "hi".' });
  expect(skills.frontmatter("---\nname: b\ndescription: >\n  one\n  two\n---")).toEqual({ name: "b", description: "one two" });
  expect(skills.frontmatter("no frontmatter")).toEqual({});
  expect(skills.body("---\nname: a\n---\n# Hi")).toBe("# Hi");
});

test.if(live)("live: the real list installs a real skill for every agent", async () => {
  const list = await skills.fetchCatalog();
  expect(list.skills.length).toBeGreaterThan(50);
  const tdd = list.skills.find((s: any) => s.id === "mattpocock/skills/skills/engineering/tdd");
  await skills.install(tdd);
  expect(readFileSync(homeOf(".claude/skills/tdd/SKILL.md"), "utf8")).toContain("name: tdd");
  const big = list.skills.reduce((a: any, b: any) => (b.count > a.count ? b : a));
  await skills.install(big);
  expect(readdirSync(app("skills", big.name), { recursive: true }).length).toBeGreaterThanOrEqual(big.count);
  const links = await skills.fromGitHub("https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling");
  expect(links.map((s: any) => s.name)).toEqual(["grilling"]);
  await skills.install(links[0]);
  expect(linked(".agents", "grilling")).toBe(true);
}, 300_000);
