// Cuts assets/zaki-icon.svg into what the `start` mod animates: the filled shapes as one-color SVGs
// (tinted by the theme) and the outlines as short polylines (outline.js), which it fades on in turn
// so the lines seem to draw themselves. Run it after changing the icon: bun scripts/start-art.ts

import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const out = `${root}defaults/mods/start/`;
const svg = readFileSync(`${root}assets/zaki-icon.svg`, "utf8");
const [vx, vy, vw, vh] = svg.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);

type Pt = [number, number];
type Shape = { group: string; d: string; x: number; y: number };

const CHUNK = 60, SMALLEST = 190, TIP = [539, 150] as Pt;

const shapes: Shape[] = [];
for (const [, group, body] of svg.matchAll(/<g id="(ink-details|horns|face-and-ruff)"[^>]*>(.*?)<\/g>/gs)) {
  for (const [path] of body.matchAll(/<path\b[^>]*>/g)) {
    const [, x, y] = path.match(/translate\(([-\d.]+),\s*([-\d.]+)\)/)!;
    shapes.push({ group, d: path.match(/\bd="([^"]+)"/)![1], x: +x, y: +y });
  }
}

// Each closed line of a shape as points, curves cut small enough to look round.
function lines(shape: Shape): Pt[][] {
  const found: Pt[][] = [];
  let line: Pt[] = [], at: Pt = [0, 0];
  for (const [, op, args] of shape.d.matchAll(/([MCZ])([^MCZ]*)/g)) {
    const n = (args.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    if (op === "M") { if (line.length) found.push(line); at = [n[0], n[1]]; line = [at]; }
    for (let i = 0; op === "C" && i + 5 < n.length; i += 6) {
      const [a, b, c, d, e, f] = n.slice(i, i + 6), from = at;
      for (let step = 1; step <= 6; step += 1) {
        const t = step / 6, u = 1 - t;
        at = [u * u * u * from[0] + 3 * u * u * t * a + 3 * u * t * t * c + t * t * t * e, u * u * u * from[1] + 3 * u * u * t * b + 3 * u * t * t * d + t * t * t * f];
        line.push(at);
      }
    }
  }
  if (line.length) found.push(line);
  return found.map((points) => points.map(([x, y]) => [x + shape.x - vx, y + shape.y - vy] as Pt));
}

const hop = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const length = (line: Pt[]) => line.slice(1).reduce((sum, p, i) => sum + hop(p, line[i]), 0);

// The outer line, without what cuts into it (a horn's ridges, the fur's points): where the line
// comes back within `gap` of itself inside `reach`, it skips the way there.
function outer(line: Pt[], gap: number, reach: number): Pt[] {
  const kept: Pt[] = [];
  for (let i = 0; i < line.length; i += 1) {
    kept.push(line[i]);
    // A horn's thin tip isn't a cut: it ends past here.
    if (line[i][0] < 150 || line[i][0] > vw - 150) continue;
    let walked = 0, back = i;
    for (let j = i + 1; j < line.length && walked < reach; j += 1) {
      walked += hop(line[j], line[j - 1]);
      if (walked > gap * 2.5 && hop(line[i], line[j]) < gap) back = j;
    }
    i = back;
  }
  return kept;
}

// Corners rounded off, closed line, so the skips don't show.
function smooth(line: Pt[]): Pt[] {
  let points = line.filter((p, i) => i === 0 || hop(p, line[i - 1]) > 0);
  for (let pass = 0; pass < 3; pass += 1) {
    points = points.flatMap((p, i) => {
      const q = points[(i + 1) % points.length];
      return [[p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25], [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]] as Pt[];
    });
  }
  return points.filter((_, i) => i % 10 === 0);
}

// Every line starts at its point nearest the head, so the art grows outward from there.
function outward(line: Pt[]): Pt[] {
  const start = line.reduce((best, p, i) => (hop(p, TIP) < hop(line[best], TIP) ? i : best), 0);
  return [...line.slice(start), ...line.slice(0, start + 1)];
}

// A line cut in stretches of about CHUNK, each with how far along it (0..1) it comes. Closed lines
// run both ways from their start, meeting at the far end.
function pieces(line: Pt[]) {
  const whole = length(line), found: { at: number; points: number[] }[] = [];
  let run: Pt[] = [line[0]], walked = 0, from = 0;
  const flush = () => {
    const middle = (from + walked) / 2 / whole;
    found.push({ at: 1 - Math.abs(1 - 2 * middle), points: run.flatMap(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]) });
    from = walked;
    run = [run.at(-1)!];
  };
  for (let i = 1; i < line.length; i += 1) {
    walked += hop(line[i], line[i - 1]);
    run.push(line[i]);
    if (walked - from >= CHUNK) flush();
  }
  if (run.length > 1) flush();
  return found;
}

const outlined = shapes.filter((s) => s.group !== "ink-details").flatMap((s) => lines(s).filter((l) => length(l) >= SMALLEST).map((l) => {
  const horn = s.group === "horns";
  return { group: horn ? "horn" : "face", line: outward(smooth(outer(l, horn ? 17 : 12, horn ? 320 : 130))) };
}));
const stretches = outlined.flatMap(({ group, line }) => pieces(line).map((piece) => ({ group, ...piece })));

const filled = (keep: (s: Shape) => boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}"><g fill="#000">${shapes.filter(keep).map((s) => `<path transform="translate(${s.x},${s.y})" d="${s.d}"/>`).join("")}</g></svg>\n`;
writeFileSync(`${out}horns.svg`, filled((s) => s.group === "horns"));
writeFileSync(`${out}face.svg`, filled((s) => s.group === "face-and-ruff"));
writeFileSync(`${out}lids.svg`, filled((s) => s.group === "ink-details" && s.y === 459));

writeFileSync(`${out}outline.js`, `// Made by scripts/start-art.ts: don't edit.\nexport const SIZE = [${vw}, ${vh}];\nexport const STRETCHES = ${JSON.stringify(stretches)};\n`);
console.log({ lines: outlined.length, stretches: stretches.length, total: Math.round(outlined.reduce((sum, { line }) => sum + length(line), 0)), points: stretches.reduce((sum, s) => sum + s.points.length / 2, 0) });
