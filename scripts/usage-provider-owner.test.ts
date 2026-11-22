import { expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adapter = `
export const networkProviders = {
  demo: {
    read: async (host) => {
      const secret = await host.env("USAGE_TEST_PROVIDER_SECRET");
      if (!secret || typeof host.now() !== "number") throw new Error("Wrong owner");
      return { limits: [{ label: "This week", used: 18, resetsAt: null }] };
    },
  },
};
`;
let calls: string[][] = [];
let stdout = "";
let localReads = 0;
let desktopHome = "/staged-app";

mock.module("herdr", () => ({
  appHome: () => desktopHome,
  home: () => "/local",
  readTextFile: async (path: string) => {
    expect(path).toBe("/staged-app/mods/workspace-chrome/provider-demo.js");
    localReads++;
    return adapter;
  },
  shared: (key: string) => key === "usage" ? { era: "test" } : undefined,
  window: () => ({ platform: process.platform === "win32" ? "windows" : "macos" }),
  exec: async (command: string, args: string[], options: { on: string }) => {
    expect(options?.on ?? null).toBe(command === "sh" && desktopHome === "/staged-app" ? "build-machine" : null);
    calls.push(args);
    const child = Bun.spawn([command, ...args], {
      env: { ...process.env, USAGE_TEST_PROVIDER_SECRET: "sample-private-value" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, text, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    stdout = text;
    return { code, stdout: text, stderr };
  },
}));

const { readOnOwner } = await import("../defaults/mods/usage/provider-owner.js");
const target = { on: "build-machine", path: "", program: "demo" };
const provider = { ownerModule: "provider-demo.js", ownerExport: "networkProviders", hosts: ["usage.example.test"] };

test.skipIf(process.platform === "win32")("the execution owner returns quota without forwarding login material", async () => {
  calls = [];
  expect(await readOnOwner(target, "demo", provider, () => true)).toEqual({
    limits: [{ label: "This week", used: 18, resetsAt: null }],
  });
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain("sample-private-value");
  expect(stdout).not.toContain("sample-private-value");
  expect(localReads).toBe(1);
});

test("revoked usage access skips the execution owner", async () => {
  calls = [];
  expect(await readOnOwner(target, "demo", provider, () => false)).toMatchObject({ state: "error", limits: [] });
  expect(calls).toHaveLength(0);
});

test("desktop owner imports the installed adapter regardless of Node package mode", async () => {
  desktopHome = mkdtempSync(join(tmpdir(), "usage-owner-"));
  const directory = join(desktopHome, "mods", "workspace-chrome");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "provider-demo.js"), adapter);
  try {
    expect(await readOnOwner({ on: null, path: "", program: "demo" }, "demo", provider, () => true)).toEqual({
      limits: [{ label: "This week", used: 18, resetsAt: null }],
    });
    expect(stdout).not.toContain("sample-private-value");
  } finally {
    rmSync(desktopHome, { recursive: true, force: true });
    desktopHome = "/staged-app";
  }
});
