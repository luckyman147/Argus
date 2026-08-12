# Argus — hundred-eyed repository navigator

Argus is a global skill + CLI that makes AI agents navigate any repository
through a persistent code index instead of reading whole files.

It builds a SQLite knowledge graph (`.opencode/repo-index.sqlite`) per project —
files, symbols, imports, references, module graph — and exposes a tiny CLI so
agents can answer **"where is the code I need?"** without burning context on
irrelevant code.

Default strategy:

```
SEARCH → LOCATE → NARROW → READ → EDIT
```

Never:

```
READ EVERYTHING → UNDERSTAND → SEARCH
```

## Install with agents

One install, every agent (Claude, OpenCode, Codex, Cursor, Copilot).

### Option A — npm (CLI + skill in one shot)

```bash
npm install -g argus-repo-navigator
```

Gives you the `argus` command everywhere:

```bash
argus search AlignmentSelector
```

Then make agents aware of the skill. The skill folder ships inside the package —
copy it into each agent's global skills directory:

```bash
# OpenCode
cp -r "$(npm root -g)/argus-repo-navigator" ~/.config/opencode/skills/argus

# Claude Code / Claude Desktop
cp -r "$(npm root -g)/argus-repo-navigator" ~/.claude/skills/argus

# Cursor
mkdir -p ~/.cursor/skills
cp -r "$(npm root -g)/argus-repo-navigator" ~/.cursor/skills/argus

# GitHub Copilot
cp -r "$(npm root -g)/argus-repo-navigator" ~/.copilot/skills/argus
```

(Windows: replace `~` with `C:\Users\<you>` and `/` with `\`.)

`argus init` inside each project then writes the AGENTS.md block so every agent
uses the index on every execution.

### Option B — git clone

```bash
git clone https://github.com/luckyman147/Argus.git argus
```

Then copy the folder into your agent skills directories (as above), or keep it
anywhere and point your agent configuration at it.

### Option C — npx (CLI only, no install)

```bash
npx argus-repo-navigator search AlignmentSelector
npx argus-repo-navigator init
```

## Usage in a project

```bash
argus init          # index + wire AGENTS.md / per-agent rules
argus search <q>    # symbols + files, each with an exact line range
```

Agent install locations (global skills, loaded on demand — no prompt cost until
used):

| Agent | Global skills dir |
|---|---|
| OpenCode | `~/.config/opencode/skills/` |
| Claude | `~/.claude/skills/` |
| Cursor | `~/.cursor/skills/` |
| GitHub Copilot | `~/.copilot/skills/` |

## Package contents

```
argus-repo-navigator/
├── SKILL.md                  # agent-facing strategy + command cheat-sheet
├── README.md                 # this file
├── LICENSE                   # MIT
└── scripts/
    ├── argus.mjs             # the `argus` CLI (bin, zero-dependency core)
    ├── package.json
    └── lib/
        ├── db.mjs            # node:sqlite schema + helpers
        ├── scan.mjs          # file walker + skip rules
        ├── lang.mjs          # per-language tables
        ├── extract.mjs       # comment/string-aware scanner (JS/TS/PHP/Py/Java/C#)
        ├── semantic.mjs      # TypeScript compiler-API pass → real call sites
        ├── init.mjs          # repo bootstrap (AGENTS.md + per-agent rules)
        └── report.mjs        # output formatting
```

Requirements:

- Node.js >= 22.5 (uses the built-in `node:sqlite`, zero runtime npm
  dependencies)
- `typescript@5` is bundled as a dependency for the semantic pass

## Setup for a project

```bash
argus init
```

`init` does four idempotent things:

1. Builds the index → `.opencode/repo-index.sqlite`
2. Adds `.opencode/repo-index.sqlite` to `.gitignore`
3. Writes an `<!-- argus:start -->` block into `AGENTS.md` (updated in place on
   re-runs, never clobbers your content)
4. Optionally wires the same block into `CLAUDE.md`, `.cursor/rules/argus.mdc`,
   and `.github/copilot-instructions.md`
   (`--agents opencode,claude,cursor,copilot`)

Result: **any** AI agent (Claude, OpenCode, Codex, Cursor, Copilot) finds the
index and the rules on every execution, with no per-agent setup.

## Commands

```bash
argus <command> [args] [--root <dir>] [--force] [--semantic] [--depth N] [--agents a,b,c]
```

| Command | Purpose |
|---|---|
| `init` | index + write AGENTS.md / per-agent rules |
| `index [--force]` | (re)build the index, incremental by mtime |
| `index --semantic` | also run the TypeScript semantic pass → precise call sites |
| `map` | file tree with languages, line counts, sizes |
| `search <q>` | symbols + files matching query, each with an exact line range |
| `symbol <n>` | definition + used-by + dependency card |
| `callers <n>` | exact call sites (after `index --semantic`) |
| `dependencies <n>` | one-level module graph of the defining file |
| `impact <n> [--depth N]` | DIRECT / INDIRECT affected files (importers chain) |
| `source <n>` | EXACT line ranges — what to pass to `read` |
| `source --file <path>` | read-range guidance for a whole file |
| `context <f>` | structural summary of a file (zero raw code) |
| `stats` | index health + repo initialization state |
| `help` | full usage |

### Typical agent loop

```bash
argus search AlignmentSelector
# → AlignmentSelector (component) — src/features/.../formatting-controls.tsx:1047-1079

argus symbol AlignmentSelector      # definition + callers + deps

argus impact AlignmentSelector      # DIRECT: files that would feel the change

argus source AlignmentSelector      # → read .../formatting-controls.tsx lines 1047-1079
```

## Index format

`.opencode/repo-index.sqlite` (SQLite via `node:sqlite`, zero deps):

| Table | Contents |
|---|---|
| `files` | path, language, size, lines, mtime |
| `symbols` | name, kind (function/class/interface/type/const/component/enum/method), line range, exported |
| `imports` | per-file module edges: source, imported names, line, resolved file |
| `refs` | usage sites: import-level always; semantic call sites after `index --semantic` |
| `meta` | stamping info (last index time, semantic pass flag) |

### Two extraction layers

- **Scanner (always, zero-dep)**: comment/string-aware tokenizer with per-language
  keyword tables — full fidelity for JS/TS/JSX, basic support for PHP, Python,
  Java, C#. Handles type annotations, arrow functions, multi-line imports, JSX.
- **Semantic (optional)**: TypeScript compiler API (`createProgram` + checker)
  resolves true call sites through import aliases — precise `callers` output.

Skips by default: `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`,
`.turbo`, `vendor`, `target`, `bin`, `obj`, caches, lockfiles, minified files,
source maps, files > 2.5 MB.

## Rules the skill enforces

- Never read a large file first: `search` → symbol → `source` → read only that range
- Thresholds: > 300 L no whole-file read by default; > 700 L always locate the
  symbol first; > 1500 L whole-file reads are exceptional
- Exploration depth: 2 levels by default (`impact --depth N` for blast radius)
- Never reread a file or range already in context (it changed → re-read)
- Token budget: "5 searches + 100 lines read" beats "10 full files read"

## Effectiveness testing

1. **Precision** — for 10 random symbols compare `source` ranges against the file
2. **Recall** — `callers` after `--semantic` vs VSCode "find references"
3. **Token accounting** — same task with/without argus; target >= 60% input-token reduction
4. **Incremental** — edit one file, re-index → `(1 changed)` in ~30 ms
5. **Idempotency** — `init` twice → one `argus:start` marker in AGENTS.md
6. **Fallback** — uninstall `typescript` → all commands still work
7. **Propagation** — fresh agent session in an initialized repo runs `argus search` before `read`

## Seen performance

| Repo | Files | Symbols | Index time |
|---|---|---|---|
| cvtex (React/Vite) + semantic | 34 | 131 (+228 refs) | ~3 s |
| nestjs monorepo | 85 | 127 | ~0.45 s |

## Verified accuracy

- `StepSkills` → `step-skills.tsx:13-75` (exact against source)
- `addSkill` → `16-21`, `removeSkill` → `23-25` (exact)
- `callers resume` → the real usage lines `page.tsx:68-70`

## Notes

- The point is not to avoid reading code — it is to avoid reading *irrelevant*
  code. Read what the task demands, but start from the smallest useful context.
- `node:sqlite` prints an experimental warning on Node 22; it is functional.
- TypeScript 7+ (the native compiler) does not expose the JS compiler API —
  this package pins `typescript@5` for the semantic pass.