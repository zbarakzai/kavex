set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

notes-clip scene version="":
    bun scripts/notes-media.ts clip "{{scene}}" "{{version}}"

notes-upload version:
    bun scripts/notes-media.ts upload "{{version}}"

notes-check version:
    bun scripts/notes-media.ts check "{{version}}"

check: test

notices:
    bun scripts/notices.ts

# Before a release: tests, docs, the next version's notes and clips, then what
# changed since the last release, to review by hand.
[unix]
pre-release: test docs-check
    #!/usr/bin/env bash
    set -euo pipefail
    version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
    last=$(git describe --tags --abbrev=0 --match 'v*')
    if grep -q "^## \[$version\]" CHANGELOG.md; then
      bun scripts/notes-media.ts check "$version"
    else
      echo "note: CHANGELOG.md has no [$version] entry yet: write the release notes before tagging."
    fi
    echo; echo "Since $last:"; git log --oneline "$last"..HEAD
    echo
    if git diff --quiet "$last"..HEAD -- src/SKILL.md; then
      echo "review: the agent manual (zaki --skill, src/SKILL.md) is unchanged since $last. Does it still match the changes above?"
    else
      echo "review: the agent manual (zaki --skill) changed since $last. Read it once more."
    fi
    echo "review: the mod guide (defaults/AGENTS.md), README.md and docs/ describe the changes above."

build:
    cargo build --locked

test:
    bun test scripts/files.test.ts scripts/markdown.test.ts scripts/tab-groups.test.ts scripts/changes.test.ts scripts/look.test.ts
    bun test scripts/tabs-column.test.ts
    bun test scripts/tab-menu.test.ts
    bun test scripts/settings.test.ts
    bun test scripts/file-menu.test.ts
    bun test scripts/reader.test.ts
    bun test scripts/start.test.ts
    bun test scripts/usage.test.ts
    cargo test --locked

docs-generate: build
    bun scripts/docs.ts generate

docs-check: build
    bun test scripts/docs.test.ts
    bun scripts/docs.ts check

# This checkout beside an installed Zaki: its own window, home and core.
[unix]
dev:
    cargo build
    HC_SESSION=zaki-dev HERDR_APP_HOME=/var/tmp/zaki-dev/home XDG_STATE_HOME=/var/tmp/zaki-dev/state HERDR_APP_ID=zaki-dev HERDR_APP_NO_SOUND=1 target/debug/zaki

[linux]
install:
    bash scripts/install-linux

[macos]
install:
    bash scripts/install-macos

[windows]
install:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1
