export const RECENT_PROJECTS = "spaces.recent";
const LIMIT = 12;

function pathKey(folder) {
  // Windows drive and UNC paths are case-insensitive. Keep the path we reopen as written.
  const path = /^(?:[a-z]:[\\/]|\\\\)/i.test(folder) ? folder.replaceAll("\\", "/").toLowerCase() : folder;
  return path.replace(/\/+$/, "");
}

const key = (project) => JSON.stringify([project.machine, pathKey(project.folder)]);

export function projectOf(space, cwd, home) {
  const fromHome = !space.machine && space.folder && pathKey(space.folder) === pathKey(home);
  const folder = !space.folder || fromHome ? cwd || space.folder : space.folder;
  const { id, name, named, active } = space;
  return { id, name, named, active, folder: folder || "", machine: space.machine ?? null };
}

function distinct(projects) {
  const kept = new Map();
  for (const project of projects) {
    if (!project?.folder) continue;
    const location = key(project);
    if (kept.has(location)) continue;
    kept.set(location, project);
    if (kept.size >= LIMIT) break;
  }
  return [...kept.values()];
}

export function rememberProjects(history, previous, current) {
  const before = new Map(previous?.map((project) => [project.id, project]));
  const known = new Set(history.map(key));
  const active = current.find((project) => project.active && project.folder);
  const touched = current.filter((project) => {
    if (!project.folder) return false;
    const old = before.get(project.id);
    if (!previous) return !known.has(key(project));
    return !old || key(old) !== key(project) || old.name !== project.name || old.named !== project.named;
  }).reverse();
  if (active && (previous ? !before.get(active.id)?.active : !known.has(key(active)))) touched.unshift(active);
  if (!touched.length) return history;
  return distinct([...touched.map(({ active: _active, ...project }) => project), ...history]);
}

function openSpace(project, current) {
  const location = key(project);
  return current.find((space) => space.id === project.id && key(space) === location)
    ?? current.find((space) => key(space) === location);
}

export function recentProjects(history, current) {
  return distinct([...history, ...current]).map((project) => {
    const space = openSpace(project, current);
    return { ...(space ?? project), open: Boolean(space) };
  });
}

export function projectCommand(project, current) {
  const space = openSpace(project, current);
  if (space) return ["space.select", { id: space.id }];
  return ["space.new", {
    folder: project.folder,
    ...(project.name && project.named ? { name: project.name } : {}),
    ...(project.machine ? { machine: project.machine } : {}),
  }];
}
