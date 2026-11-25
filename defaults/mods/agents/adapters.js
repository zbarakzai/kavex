// Every agent whose session Kavex follows, by its program key: rows and terminal notes both use
// this one list. See sessions.js for what an agent here is.

import { antigravity } from "./antigravity.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { pi } from "./pi.js";

export const AGENTS = { claude, codex, pi, antigravity };
