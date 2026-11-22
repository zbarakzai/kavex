import { expect, test } from "bun:test";
import { projectOf, rememberProjects, recentProjects, projectCommand } from "../defaults/mods/spaces/history.js";

const project = (id: string, folder: string, other: { name?: string; machine?: string; active?: boolean } = {}) =>
  ({ id, folder, name: id, named: true, machine: null, active: false, ...other });

test("new projects and visited spaces move to the top, and closing a space keeps its project", () => {
  const atlas = project("Atlas", "/work/atlas", { active: true });
  const meter = project("Meter", "/work/meter");
  const opened = [atlas, meter];
  const stored = rememberProjects([], null, opened);
  expect(stored.map((p) => p.id)).toEqual(["Atlas", "Meter"]);

  const visited = [{ ...atlas, active: false }, { ...meter, active: true }];
  const recent = rememberProjects(stored, opened, visited);
  expect(recent.map((p) => p.id)).toEqual(["Meter", "Atlas"]);
  expect(rememberProjects(recent, visited, [visited[0]])).toBe(recent);
  expect(rememberProjects(recent, visited, [...visited, project("Relay", "/work/relay")])[0].id).toBe("Relay");
});

test("one folder appears once per machine and reopening it updates the space ID", () => {
  const local = project("Local", "/work/atlas");
  const remote = project("Remote", "/work/atlas", { machine: "build" });
  const replacement = project("Replacement", "/work/atlas/", { active: true });
  const history = rememberProjects([local, remote], [local], [replacement]);
  expect(history.map((p) => p.id)).toEqual(["Replacement", "Remote"]);
  expect(recentProjects(history, [replacement]).map((p) => p.open)).toEqual([true, false]);
});

test("choosing a project goes to its open space or starts a new one in the saved folder", () => {
  const saved = project("Atlas", "C:\\work\\Atlas", { machine: "build" });
  const reopened = project("Next", "c:/work/atlas", { machine: "build" });
  expect(projectCommand(saved, [reopened])).toEqual(["space.select", { id: "Next" }]);
  expect(projectCommand(saved, [])).toEqual(["space.new", { folder: "C:\\work\\Atlas", machine: "build", name: "Atlas" }]);
  expect(projectCommand({ ...saved, named: false, machine: null }, [])).toEqual(["space.new", { folder: "C:\\work\\Atlas" }]);
});

test("a home space can remember a project reached in the terminal while an explicit project keeps its root", () => {
  const home = "/home/me";
  expect(projectOf(project("Shell", home), "/work/atlas", home).folder).toBe("/work/atlas");
  expect(projectOf(project("Atlas", "/work/atlas"), "/work/atlas/src", home).folder).toBe("/work/atlas");
  expect(projectOf(project("Remote", "", { machine: "build" }), "/home/build/atlas", home).folder).toBe("/home/build/atlas");
});

test("the history stays bounded and preserves its order on reopening Kavex", () => {
  const projects = Array.from({ length: 20 }, (_, i) => project(`Space ${i}`, `/work/${i}`));
  const history = rememberProjects([], null, projects);
  expect(history.length).toBe(12);
  expect(rememberProjects(history, null, [...history].reverse())).toBe(history);
});
