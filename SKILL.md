---
name: argus
description: >-
  Hundred-eyed repository navigator. Search a persistent code index (symbols,
  imports, references, module graph) and read only exact line ranges instead of
  whole files. Use when working in large or unfamiliar repositories, locating
  symbols/functions/components, assessing impact of changes, reducing token
  consumption, or initializing a repo (argus init) so any AI agent navigates it
  efficiently in every execution.
---

# Argus — repo-navigator

## PRIMARY OBJECTIVE

Minimize token consumption caused by unnecessary file reads.

Default strategy:

```
SEARCH → LOCATE → NARROW → READ → EDIT
```

Never:

```
READ EVERYTHING → UNDERSTAND → SEARCH
```

## The Index

Argus builds `.opencode/repo-index.sqlite` in the project root:

- `files`: path, language, size, lines, mtime
- `symbols`: name, kind (function/class/interface/type/const/component/enum/method), line range, exported
- `imports`: per-file module graph edges (source → resolved file)
- `refs`: usage sites (import-level always; semantic call sites after `index --semantic`)

The index is a MAP, not source code. Query it; never dump it into context.

### Run the CLI

```bash
argus <command> [--root <dir>]
```

A bare `argus` command is installed on PATH by `argus init` / `argus shim`
(or by `npm install -g argus-repo-navigator`). If it is not on PATH, fall back
to:

```bash
node <skill>/scripts/argus.mjs <command>
```

(`<skill>` = this skill's directory; on this machine:
`C:/Users/Iyed/.config/opencode/skills/argus`)

### Command cheat-sheet

| Command | Purpose |
|---|---|
| `shim` | install the bare `argus` command on PATH (run once per machine) |
| `init` | index + shim + write AGENTS.md / CLAUDE.md / .cursor / copilot rules so every agent uses argus on every execution |
| `index [--force]` | (re)build the index, incremental by mtime |
| `index --semantic` | also run TypeScript semantic pass → precise call sites |
| `map` | file tree with languages, line counts, sizes |
| `search <q>` | symbols + files matching query, each with exact line range |
| `symbol <n>` | definition + used-by + dependency card |
| `callers <n>` | exact call sites (after `index --semantic`) |
| `dependencies <n>` | one-level module graph of the defining file |
| `impact <n> [--depth N]` | DIRECT / INDIRECT affected files |
| `source <n>` | EXACT line ranges — what to pass to `read` |
| `context <f>` | structural summary of a file, zero raw code |
| `stats` | index health; is the repo initialized? |

You may also use `grep` / `glob` / `git diff` etc. instead of or before argus —
cheap discovery always beats reading.

## Core Rules

### 1. Never read a large file first

Before `read` on a source file:

1. Identify the file via `search` / `grep` / `glob`.
2. Identify the relevant symbol.
3. Get its line range with `argus source <symbol>`.
4. Read ONLY that range (e.g. `read src/a.ts lines 1047-1079`).
5. Avoid whole-file reads unless the file is small (<~300 lines), the file
   structure is itself the task, or the task explicitly needs it.

### 2. Search before read — priority order

1. `argus search` (index)
2. exact symbol / filename search
3. `argus callers` / `grep` usage search
4. `argus impact` for affected code
5. `glob`
6. `read` targeted ranges only

### 3. Large-file thresholds

| File size | Policy |
|---|---|
| > 300 L | do not read whole file by default |
| > 700 L | always locate the symbol first |
| > 1500 L | whole-file read is exceptional |

### 4. Exploration depth

Follow only directly related chains (component → imported hook/service →
relevant API → relevant model). Maximum default exploration depth: 2 levels.
`argus impact --depth 3` when the task needs the blast radius.

### 5. Generated / low-value files — never read

`node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `coverage/`, `.turbo/`,
`vendor/`, `target/`, `bin/`, `obj/`, cache, lockfiles, minified files,
source maps, generated code. (Argus already skips them at index time.)

### 6. Repeated reads

Never reread a file or line range already in context unless it changed or you
lost the context. Remember discovered paths, symbols, ranges, dependencies.

### 7. Editing

1. Locate exact implementation (`argus symbol` / `source`).
2. Read only relevant code.
3. Check directly related types/interfaces.
4. Smallest change possible; then inspect the diff; don't reread the file.

### 8. Token budget

Prefer `5 searches + 100 lines read` over `10 full files read`.
Prefer `index → exact symbol → exact lines` over repository-wide exploration.
If you have enough to make the change safely — STOP EXPLORING.

## First run in a new repo

1. `argus index` (or `argus init` to also wire every agent into the repo).
2. If the repo already has `AGENTS.md` from a previous `init` but no
   `.opencode/repo-index.sqlite` → `index` first.
3. Run `argus stats` to confirm readiness.

## Important

The point is NOT to avoid reading code. It is to avoid reading IRRELEVANT code.
Accuracy has priority over token savings — read what the task demands, but
always start from the smallest useful context.