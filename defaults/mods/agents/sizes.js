// What `wc -c` said about some session files: `[{ file, size }]`.
export const sizes = (stdout) => stdout.split("\n").flatMap((line) => {
  const [, size, file] = line.match(/^\s*(\d+)\s(.+\.jsonl)$/) ?? [];
  return file ? [{ file, size: Number(size) }] : [];
});
