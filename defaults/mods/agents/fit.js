// What an agent row shows at its width. The name always keeps a few letters; the rest
// gives way, least useful first. Widths are px measured off the drawn row, with a little slack.
const CHAR = 7, DIGIT = 7, MONO = 6, BADGE_LETTER = 6.4;
const PAD = 16, LOGO = 22, NAME_MIN = 40, INDEX_GAP = 4, SPINNER = 13, SPINNER_GAP = 6, DOT = 10, PIN = 20;
const WIDE = 9, TIGHT = 6;

// Most to least worth keeping is right to left: each list drops from its start.
const ORDER = {
  working: ["gap", "spinner", "time", "percent", "word"],
  // Idle is the least news: a dot says it.
  idle: ["gap", "word", "time", "percent"],
  other: ["gap", "time", "percent", "word"],
};

const badgeWidth = (label) => 12 + label.length * BADGE_LETTER;

// row: { name, tab, status, label (its badge's word), percent (text or null), time (text or null),
// hot (percent at 90+), hovered (the pin takes the time's place), extra (machine, fold) }.
export function fitRow(width, row) {
  const show = { gap: true, spinner: row.status === "working", time: Boolean(row.time) || row.hovered, percent: row.percent != null, word: true };
  const need = () => {
    const parts = [LOGO, Math.min(row.name.length * CHAR, NAME_MIN) + INDEX_GAP + CHAR + String(row.tab).length * DIGIT];
    if (row.extra) parts.push(row.extra);
    if (show.percent) parts.push(String(row.percent).length * MONO);
    if (show.time) parts.push(row.hovered ? PIN : String(row.time).length * MONO);
    parts.push(show.word ? badgeWidth(row.label) + (show.spinner ? SPINNER + SPINNER_GAP : 0) : DOT);
    return PAD + parts.reduce((a, b) => a + b, 0) + (parts.length - 1) * (show.gap ? WIDE : TIGHT);
  };
  let steps = ORDER[row.status] ?? ORDER.other;
  if (row.hot) steps = [...steps.filter((s) => s !== "percent"), "percent"];
  // The pin is how a row gets pinned: hovered, it stays.
  if (row.hovered) steps = steps.filter((s) => s !== "time");
  for (const step of steps) {
    if (need() <= width) break;
    show[step] = false;
  }
  return { gap: show.gap ? WIDE : TIGHT, spinner: show.spinner && show.word, time: show.time, percent: show.percent, word: show.word };
}
