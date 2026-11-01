import { test, expect } from "bun:test";
import { isMarkdown, isAbsolute, forward, tidy, linkTarget, headingFor, readerLook } from "../defaults/mods/files/markdown.js";

test("Markdown files are known by their extension, in any case", () => {
  for (const name of ["a.md", "A.MD", "dir.x/b.markdown", "c.mdx", "d.mdown", "e.mkd"]) expect(isMarkdown(name)).toBe(true);
  for (const name of ["a.txt", "md", ".mdx.bak", "", null, undefined]) expect(isMarkdown(name)).toBe(false);
});

test("Absolute paths include Windows drives", () => {
  for (const path of ["/a", "C:/a", "c:\\a"]) expect(isAbsolute(path)).toBe(true);
  for (const path of ["a", "./a", "../a", "", null]) expect(isAbsolute(path)).toBe(false);
});

test("Windows paths turn their slashes; a backslash in a Unix name stays", () => {
  expect(forward("C:\\repo\\docs\\a.md")).toBe("C:/repo/docs/a.md");
  expect(forward("/repo/a\\b.md")).toBe("/repo/a\\b.md");
  expect(forward(null)).toBeNull();
});

test("Paths lose their dots, and can't climb past the root", () => {
  expect(tidy("/a/b/../c/./d.md")).toBe("/a/c/d.md");
  expect(tidy("/../../a.md")).toBe("/a.md");
  expect(tidy("a/../../b.md")).toBe("b.md");
  expect(tidy("C:/a/../b.md")).toBe("C:/b.md");
});

test("Links go to the web, a heading here, or a file beside the document", () => {
  const folder = "/repo/docs";
  expect(linkTarget("https://a.com/x.md", folder)).toEqual({ web: "https://a.com/x.md" });
  expect(linkTarget("#set-up", folder)).toEqual({ anchor: "set-up" });
  expect(linkTarget("guide.md", folder)).toEqual({ file: "/repo/docs/guide.md", anchor: undefined });
  expect(linkTarget("../README.md#install", folder)).toEqual({ file: "/repo/README.md", anchor: "install" });
  expect(linkTarget("my%20notes.md?plain=1", folder)).toEqual({ file: "/repo/docs/my notes.md", anchor: undefined });
  expect(linkTarget("/etc/motd.md", folder)).toEqual({ file: "/etc/motd.md", anchor: undefined });
  expect(linkTarget("file:///repo/x.md", folder)).toEqual({ file: "/repo/x.md", anchor: undefined });
  expect(linkTarget("mailto:a@b.c", folder)).toEqual({ other: "mailto:a@b.c" });
  expect(linkTarget("javascript:alert(1)", folder)).toEqual({ other: "javascript:alert(1)" });
});

test("A bad escape in a link is kept as written, not thrown", () => {
  expect(linkTarget("100%.md", "/r")).toEqual({ file: "/r/100%.md", anchor: undefined });
});

test("Anchors find headings the way GitHub names them, repeats numbered", () => {
  const outline = ["Set up", "What's new?", "Set up", "API: `run()`", "Überblick"].map((text, block) => ({ level: 2, text, block }));
  expect(headingFor(outline, "set-up")?.block).toBe(0);
  expect(headingFor(outline, "set-up-1")?.block).toBe(2);
  expect(headingFor(outline, "whats-new")?.block).toBe(1);
  expect(headingFor(outline, "api-run")?.block).toBe(3);
  expect(headingFor(outline, "ÜBERBLICK")?.block).toBe(4);
  expect(headingFor(outline, "nope")).toBeNull();
});

test("The look only uses the theme's colors, each one a color", () => {
  const theme: Record<string, string> = new Proxy({}, { get: (_t, name) => `#${(String(name).length * 40503 % 0xffffff).toString(16).padStart(6, "0")}` });
  const look = readerLook(theme);
  const colors = [...Object.entries(look).filter(([key]) => !key.endsWith("_icon")).map(([, value]) => value)].flatMap((value) => (typeof value === "string" ? [value] : Object.values(value as object)));
  for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
  expect(look.alerts).toHaveLength(5);
  // Selections paint over the glyphs: opaque, they hide what's selected.
  expect(look.selection).toMatch(/^#[0-9a-f]{8}$/);
});
