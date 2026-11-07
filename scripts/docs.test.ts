import { describe, expect, test } from "bun:test";
import { checkExample, checkMarkdown, commandPage, type Reference } from "./docs";

const ref: Reference = {
  help: "Usage:\n  kavex status\n  kavex ls\n  kavex do <command> [args]\n  kavex commands\n  kavex --skill\n  kavex --version\n",
  commands: [{ name: "pane.split", about: "Split a pane.", args: [{ name: "direction", required: true }] }],
};

describe("CLI examples", () => {
  test("validates commands and named arguments without executing examples", () => {
    for (const source of ["kavex", "kavex ls", "kavex --help", "kavex --skill", "kavex do pane.split --direction right", `kavex do pane.split '{"direction":"right"}'`]) {
      expect(checkExample(source, ref)).toEqual([]);
    }
    expect(checkExample("kavex wat", ref)).toEqual(["unknown command or flag: wat"]);
    expect(checkExample("kavex ls && kavex wat", ref)).toEqual(["unknown command or flag: wat"]);
    expect(checkExample("kavex --wat", ref)).toHaveLength(1);
    expect(checkExample("kavex ls --wat", ref)).toHaveLength(1);
    expect(checkExample("kavex do pane.wat", ref)).toHaveLength(1);
    expect(checkExample("kavex do pane.split --wat right", ref)).toHaveLength(1);
    expect(checkExample("kavex do pane.split --direction=right", ref)).toContain("unknown flag for do: --direction=right");
    expect(checkExample("kavex do pane.split --direction='right'", ref)).toContain("unknown flag for do: --direction=right");
    expect(checkExample('kavex ls "--wat"', ref)).toEqual(["unknown flag for ls: --wat"]);
    expect(checkExample('kavex do pane.split "--wat" right', ref)).toEqual(["unknown flag for do: --wat"]);
    expect(checkExample('kavex do pane.split "--direction" "right"', ref)).toEqual([]);
    expect(checkExample("kavex do pane.split --direction", ref)).toEqual(["missing value for --direction"]);
  });

  test("ignores flags inside quotes and comments, and other programs", () => {
    expect(checkExample(`kavex do pane.split --direction '--not-a-flag' # --comment`, ref)).toEqual([]);
    expect(checkExample("curl --not-our-flag https://example.org", ref)).toEqual([]);
    expect(checkExample("kavex ls | other --not-our-flag", ref)).toEqual([]);
    expect(checkExample("kavex do pane.split --direction kavex", ref)).toEqual([]);
  });

  test("reports inline and fenced examples with file and line", () => {
    expect(checkMarkdown("README.md", "Text `kavex wat`.\n\n```sh\nkavex ls --wat\n```", ref)).toEqual([
      "README.md:1: unknown command or flag: wat",
      "README.md:4: unknown flag for ls: --wat",
    ]);
    expect(checkMarkdown("docs/example.md", "~~~sh\nkavex do pane.split \\\n  --wat right\n~~~", ref)).toEqual(["docs/example.md:2: unknown flag for do: --wat"]);
    expect(checkMarkdown("README.md", "Plain prose kavex wat is not code.", ref)).toEqual([]);
  });
});

test("command reference comes from the catalog", () => {
  const page = commandPage(ref.commands);
  expect(page).toContain("## `pane.split`");
  expect(page).toContain("| `direction` | yes |");
  expect(page).toContain("Split a pane.");
  expect(checkMarkdown("docs/commands.md", page, ref)).toEqual([]);
});

