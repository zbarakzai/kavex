// Local notes, one versioned document per agent session or terminal run.
import { appHome, readTextFile, setShared, window, writeTextFile } from "herdr";

function pathOf({ machine = null, agent, session, terminalRun }) {
  if (!session && !terminalRun) throw new Error("No session or terminal for this note.");
  const scope = session ? ["session", machine, agent, session] : ["terminal", machine, terminalRun];
  // Escape unusual characters and uppercase letters, even on case-insensitive disks.
  const filename = Array.from(JSON.stringify(scope), (c) =>
    /^[a-y0-9]$/.test(c) ? c : `z${c.codePointAt(0).toString(16)}z`).join("");
  const separator = window()?.platform === "windows" ? "\\" : "/";
  const parts = filename.match(/.{1,120}/g);
  return [appHome(), "terminal-notes", ...parts].join(separator) + ".json";
}

function valid(note) {
  return note && typeof note.id === "string" && typeof note.text === "string" && typeof note.comment === "string";
}

async function load(path) {
  const raw = await readTextFile(path);
  if (raw === null) return { raw, items: [] };
  const saved = JSON.parse(raw);
  if (saved?.version !== 1 || !Array.isArray(saved.items) || !saved.items.every(valid)) {
    throw new Error("This notes file has an unsupported format.");
  }
  return { raw, items: saved.items };
}

export async function listNotes(scope) {
  return (await load(pathOf(scope))).items;
}

export async function saveNote(scope, { text, comment = "", anchor = null }) {
  if (!text?.trim()) throw new Error("Select some text to save a note.");
  const path = pathOf(scope);
  const created = Date.now();
  const id = `${created.toString(36)}-${Math.random().toString(36).slice(2)}`;
  const note = { id, text, comment, anchor, created };
  for (let attempt = 0; attempt < 5; attempt++) {
    const { raw, items } = await load(path);
    try {
      await writeTextFile(path, JSON.stringify({ version: 1, items: [note, ...items] }, null, 2) + "\n", raw);
      setShared("terminal.notes.changed", id);
      return note;
    } catch (error) {
      if (await readTextFile(path) === raw) throw error;
    }
  }
  throw new Error("Notes changed while saving. Try saving again.");
}
