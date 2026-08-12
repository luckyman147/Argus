#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, replaceFileRows, upsertFile, removeMissingFiles, insertSymbol, insertImport, setMeta, getMeta } from './lib/db.mjs';
import { walkFiles, extLang, fileStats, readSource, countLines, isValidSourceFile } from './lib/scan.mjs';
import { maskSource, extractSymbols, extractImports } from './lib/extract.mjs';
import { languageKind, isLikelyComponent } from './lib/lang.mjs';
import { resolveTypeScript, analyzeSemantic } from './lib/semantic.mjs';
import { initProject, isInitialized } from './lib/init.mjs';
import { installShim, shimBinDir } from './lib/shim.mjs';
import { humanSize, banner, list } from './lib/report.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(SCRIPTS_DIR);
const DB_REL = '.opencode/repo-index.sqlite';

function norm(p) {
  return p.split('\\').join('/');
}

function parseArgs(argv) {
  const flags = { root: process.cwd(), force: false, semantic: false, depth: 3, agents: ['opencode', 'claude', 'cursor', 'copilot'], noShim: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') flags.force = true;
    else if (a === '--semantic') flags.semantic = true;
    else if (a === '--no-shim') flags.noShim = true;
    else if (a === '--root') flags.root = path.resolve(argv[++i]);
    else if (a === '--depth') flags.depth = parseInt(argv[++i], 10) || 3;
    else if (a === '--agents') flags.agents = argv[++i].split(',').map((x) => x.trim());
    else positional.push(a);
  }
  return { flags, positional };
}

function dbPathFor(root) {
  return path.join(root, DB_REL);
}

function openProjectDb(root) {
  fs.mkdirSync(path.join(root, '.opencode'), { recursive: true });
  return openDb(dbPathFor(root));
}

function resolveImportTarget(root, importerRel, source) {
  if (!source.startsWith('.')) return null;
  const importerAbs = path.join(root, importerRel);
  const base = path.resolve(path.dirname(importerAbs), source);
  const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];
  for (const e of exts) {
    const cand = base + e;
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return norm(path.relative(root, cand));
    }
  }
  return null;
}

async function indexRepo(root, opts = {}) {
  const t0 = Date.now();
  const db = openProjectDb(root);
  const files = walkFiles(root).filter(isValidSourceFile);
  const present = new Set();
  let indexed = 0;
  let changedFiles = 0;

  for (const abs of files) {
    const rel = norm(path.relative(root, abs));
    present.add(rel);
    const lang = extLang(abs);
    const st = fileStats(abs);
    const stored = db.prepare('SELECT id, mtime FROM files WHERE path = ?').get(rel);
    if (stored && !opts.force && stored.mtime === st.mtime) {
      indexed++;
      continue;
    }
    const src = readSource(abs);
    if (src === null) continue;
    const mask = maskSource(src);
    const symbols = extractSymbols(lang, src, mask);
    const imports = extractImports(lang, src, mask);

    replaceFileRows(db, stored?.id ?? -1);
    const { id: fileId, changed } = upsertFile(db, rel, languageKind(lang), st.size, countLines(src), st.mtime);
    if (changed || opts.force) changedFiles++;

    for (const s of symbols) {
      const kind = isLikelyComponent(s.name, s.kind, lang) ? 'component' : s.kind;
      insertSymbol(db, fileId, s.name, kind, s.start, s.end, s.exported);
    }
    for (const im of imports) {
      insertImport(db, fileId, im.source, im.names, im.line, null);
    }
    indexed++;
    if (indexed % 300 === 0) process.stdout.write(`  indexed ${indexed}/${files.length} files\r`);
  }

  const unresolved = db.prepare("SELECT i.id, i.source, f.path AS importer FROM imports i JOIN files f ON f.id = i.file_id WHERE i.resolved_id IS NULL AND (i.source LIKE './%' OR i.source LIKE '../%')").all();
  const relToId = new Map(
    db.prepare('SELECT id, path FROM files').all().map((r) => [r.path, r.id])
  );
  for (const u of unresolved) {
    const target = resolveImportTarget(root, u.importer, u.source);
    if (target && relToId.has(target)) {
      db.prepare('UPDATE imports SET resolved_id = ? WHERE id = ?').run(relToId.get(target), u.id);
    }
  }

  const refInsert = db.prepare('INSERT OR IGNORE INTO refs(file_id, symbol_id, name, line, kind) VALUES(?,?,?,?,?)');
  const symByFile = db.prepare('SELECT id, name FROM symbols WHERE name = ?');
  for (const ir of db.prepare('SELECT file_id, names, line FROM imports').all()) {
    for (const name of JSON.parse(ir.names)) {
      for (const s of symByFile.all(name)) {
        refInsert.run(ir.file_id, s.id, name, ir.line, 'import');
      }
    }
  }
  removeMissingFiles(db, present);
  setMeta(db, 'last_index_ms', Date.now());
  setMeta(db, 'file_count', files.length);
  setMeta(db, 'semantic_pass', getMeta(db, 'semantic_pass') === '1' && !opts.force ? '1' : '0');
  db.close();

  let semantic = 0;
  if (opts.semantic) {
    if (resolveTypeScript()) {
      const db2 = openProjectDb(root);
      const rows = db2.prepare('SELECT id, path FROM files WHERE lang IN (?,?)').all('ts', 'tsx');
      semantic = analyzeSemantic(db2, rows, root, (a, b) => a % 100 === 0 && process.stdout.write(`  semantic pass ${a}/${b}\r`));
      db2.close();
    } else {
      console.log('  ! --semantic requested but typescript is not installed in the argus skill dir');
    }
  }
  return { files: files.length, changedFiles, ms: Date.now() - t0, semantic };
}

function cmdIndex(positional, flags) {
  const res = indexRepo(flags.root, { force: flags.force, semantic: flags.semantic });
  res.then((r) => {
    console.log(`\nindexed ${r.files} files (${r.changedFiles} changed) in ${r.ms} ms`);
    if (r.semantic > 0) console.log(`semantic pass: ${r.semantic} reference sites resolved`);
    const db = openProjectDb(flags.root);
    const counts = {
      symbols: db.prepare('SELECT COUNT(*) c FROM symbols').get().c,
      refs: db.prepare('SELECT COUNT(*) c FROM refs').get().c,
      imports: db.prepare('SELECT COUNT(*) c FROM imports').get().c,
    };
    db.close();
    console.log(`symbols: ${counts.symbols}  refs: ${counts.refs}  imports: ${counts.imports}`);
    console.log(`index: ${dbPathFor(flags.root)}`);
  });
}

function cmdMap(positional, flags) {
  const db = openProjectDb(flags.root);
  const rows = db.prepare('SELECT path, lang, size, lines FROM files ORDER BY path').all();
  const buckets = new Map();
  for (const r of rows) {
    const top = r.path.split('/')[0] || '(root)';
    if (!buckets.has(top)) buckets.set(top, []);
    buckets.get(top).push(r);
  }
  console.log(`\n${rows.length} files — ${humanSize(rows.reduce((a, r) => a + r.size, 0))}`);
  for (const [top, files] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${top}/  (${files.length} files, ${humanSize(files.reduce((a, r) => a + r.size, 0))})`);
    const shown = files.slice(0, 25);
    shown.forEach((f, i) => {
      console.log(`  ${i === shown.length - 1 && files.length <= 25 ? '└─' : '├─'} ${f.path}  ${f.lang}  ${f.lines}L  ${humanSize(f.size)}`);
    });
    if (files.length > 25) console.log(`  └─ … ${files.length - 25} more`);
  }
  db.close();
}

function cmdSearch(positional, flags) {
  if (positional.length === 0) {
    console.log('usage: argus search <query>');
    return;
  }
  const q = positional[0];
  const db = openProjectDb(flags.root);
  const symbols = db.prepare('SELECT s.name, s.kind, s.start_line, s.end_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ?').all(q);
  const partial = symbols.length === 0
    ? db.prepare("SELECT s.name, s.kind, s.start_line, s.end_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name LIKE ? ORDER BY length(s.name), s.name LIMIT 15").all(`%${q}%`)
    : [];
  const files = db.prepare('SELECT path, lang, lines, size FROM files WHERE path LIKE ? LIMIT 8').all(`%${q}%`);

  console.log(banner(`SYMBOLS — "${q}"`));
  const rows = symbols.length ? symbols : partial;
  if (rows.length === 0) console.log('  (no symbol match)');
  rows.forEach((r) => console.log(`  ${r.name} (${r.kind}) — ${r.path}:${r.start_line}-${r.end_line}${symbols.length && q === r.name ? '  ← exact' : ''}`));

  if (files.length) {
    console.log(banner('FILES'));
    files.forEach((f) => console.log(`  ${f.path}  ${f.lang}  ${f.lines}L  ${humanSize(f.size)}`));
  }
  db.close();
}

function symbolCard(db, name, flags, withCallers = true) {
  const defs = db.prepare('SELECT s.id, s.kind, s.start_line, s.end_line, s.exported, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ?').all(name);
  if (defs.length === 0) return null;
  console.log(banner(`SYMBOL — ${name}`));
  for (const d of defs) {
    console.log(`  defined: ${d.path}:${d.start_line}-${d.end_line}  (${d.kind}${d.exported ? ', exported' : ''})`);
  }
  if (withCallers) {
    const used = db.prepare('SELECT DISTINCT f.path, r.line, r.kind FROM refs r JOIN files f ON f.id = r.file_id JOIN symbols s ON s.id = r.symbol_id WHERE s.name = ? ORDER BY f.path, r.line LIMIT 25').all(name);
    console.log('');
    list('used by', used.map((u) => `${u.path}:${u.line} [${u.kind}]`)).forEach((l) => console.log('  ' + l));
  }
  return defs;
}

function cmdSymbol(positional, flags) {
  if (positional.length === 0) {
    console.log('usage: argus symbol <name>');
    return;
  }
  const db = openProjectDb(flags.root);
  const defs = symbolCard(db, positional[0], flags);
  if (!defs) console.log(`  (no symbol named "${positional[0]}")`);
  db.close();
}

function cmdCallers(positional, flags) {
  if (positional.length === 0) {
    console.log('usage: argus callers <name>');
    return;
  }
  const name = positional[0];
  const db = openProjectDb(flags.root);
  const defs = db.prepare('SELECT s.id, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ?').all(name);
  if (defs.length === 0) {
    console.log(`  (no symbol named "${name}")`);
    db.close();
    return;
  }
  const refs = db.prepare('SELECT DISTINCT f.path, r.line, r.kind FROM refs r JOIN files f ON f.id = r.file_id JOIN symbols s ON s.id = r.symbol_id WHERE s.name = ? ORDER BY f.path, r.line').all(name);
  console.log(banner(`CALLERS — ${name} (${refs.length} sites)`));
  if (refs.length === 0) {
    console.log('  none recorded. Run `argus index --semantic` for precise call sites.');
  }
  refs.forEach((r) => console.log(`  ${r.path}:${r.line}  [${r.kind}]`));
  const semanticPass = getMeta(db, 'semantic_pass');
  if (semanticPass !== '1') console.log('\n  hint: run `argus index --semantic` for real semantic references');
  db.close();
}

function fileImports(db, fileId) {
  return db.prepare('SELECT i.source, i.names, i.line, f.path AS resolved FROM imports i LEFT JOIN files f ON f.id = i.resolved_id WHERE i.file_id = ?').all(fileId);
}

function cmdDependencies(positional, flags) {
  if (positional.length === 0) {
    console.log('usage: argus dependencies <symbol>');
    return;
  }
  const name = positional[0];
  const db = openProjectDb(flags.root);
  const defs = db.prepare('SELECT s.id, f.id file_id, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ?').all(name);
  if (defs.length === 0) {
    console.log(`  (no symbol named "${name}")`);
    db.close();
    return;
  }
  const seen = new Set();
  for (const d of defs) {
    if (seen.has(d.file_id)) continue;
    seen.add(d.file_id);
    console.log(banner(`DEPENDENCIES — ${name} (in ${d.path})`));
    for (const im of fileImports(db, d.file_id)) {
      const names = JSON.parse(im.names);
      const label = names.length ? `${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''} from ` : '';
      console.log(`  ├─ ${label}"${im.source}"${im.resolved ? ' → ' + im.resolved : '  (external)'}`);
    }
  }
  db.close();
}

function moduleGraph(db) {
  const out = new Map();
  const impList = db.prepare('SELECT file_id, resolved_id FROM imports WHERE resolved_id IS NOT NULL').all();
  for (const i of impList) {
    if (!out.has(i.file_id)) out.set(i.file_id, new Set());
    out.get(i.file_id).add(i.resolved_id);
  }
  const inEdges = new Map();
  for (const [from, set] of out) {
    for (const to of set) {
      if (!inEdges.has(to)) inEdges.set(to, new Set());
      inEdges.get(to).add(from);
    }
  }
  return { out, inEdges };
}

function cmdImpact(positional, flags) {
  if (positional.length === 0) {
    console.log('usage: argus impact <name> [--depth N]');
    return;
  }
  const name = positional[0];
  const db = openProjectDb(flags.root);
  const defs = db.prepare('SELECT s.id, f.id file_id, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ?').all(name);
  if (defs.length === 0) {
    console.log(`  (no symbol named "${name}")`);
    db.close();
    return;
  }
  const refFiles = new Set(
    db.prepare('SELECT DISTINCT r.file_id FROM refs r JOIN symbols s ON s.id = r.symbol_id WHERE s.name = ?').all(name).map((r) => r.file_id)
  );
  const seed = new Set([...defs.map((d) => d.file_id), ...refFiles]);
  const { inEdges } = moduleGraph(db);
  const visited = new Set(seed);
  const levels = [];
  let frontier = [...seed];
  for (let hop = 1; hop <= flags.depth; hop++) {
    const next = new Set();
    for (const f of frontier) {
      for (const n of inEdges.get(f) ?? []) {
        if (!visited.has(n)) {
          visited.add(n);
          next.add(n);
        }
      }
    }
    levels.push([...next]);
    frontier = [...next];
    if (next.size === 0) break;
  }
  const filePath = (id) => db.prepare('SELECT path FROM files WHERE id = ?').get(id)?.path ?? '?';
  console.log(banner(`IMPACT — ${name} (depth ${flags.depth})`));
  console.log(`  seed: ${[...seed].map(filePath).join(', ')}`);
  levels.forEach((level, i) => {
    console.log(`\n  ${i === 0 ? 'DIRECT' : `INDIRECT (${i + 1} hop${i + 1 > 1 ? 's' : ''})`} — ${level.length} file${level.length === 1 ? '' : 's'}`);
    level.forEach((f) => console.log(`    ${filePath(f)}`));
  });
  if (levels.every((l) => l.length === 0)) console.log('\n  no connected files');
  db.close();
}

function cmdSource(positional, flags) {
  if (positional.length === 0) {
    console.log('usage: argus source <symbol>   |   argus source --file <path>');
    return;
  }
  const db = openProjectDb(flags.root);
  if (positional[0] === '--file') {
    const q = positional[1];
    const f = db.prepare('SELECT path, lines FROM files WHERE path = ?').get(q);
    if (!f) {
      console.log(`  (no file "${q}")`);
    } else {
      console.log(`\nread ${f.path} (${f.lines} L) — read in ranges, or:\n  read ${f.path} lines 1-${Math.min(f.lines, 200)}`);
    }
    db.close();
    return;
  }
  const defs = db.prepare('SELECT s.name, f.path, s.start_line, s.end_line, s.kind, f.lines FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ?').all(positional[0]);
  if (defs.length === 0) {
    console.log(`  (no symbol named "${positional[0]}")`);
  }
  for (const d of defs) {
    const n = d.end_line - d.start_line + 1;
    console.log(`\n${d.name} (${d.kind})`);
    console.log(`  read ${d.path} lines ${d.start_line}-${d.end_line}   (${n} L of ${d.lines} L total)`);
  }
  console.log('\n  > only read what you need: SEARCH → LOCATE → NARROW → READ → EDIT');
  db.close();
}

function cmdContext(positional, flags) {
  if (positional.length === 0) {
    console.log('usage: argus context <file>');
    return;
  }
  const q = positional[0];
  const db = openProjectDb(flags.root);
  const f = db.prepare('SELECT id, path, lang, lines, size FROM files WHERE path = ?').get(q)
    ?? db.prepare('SELECT id, path FROM files WHERE path LIKE ? LIMIT 1').get(`%${q}%`);
  if (!f) {
    console.log(`  (no file matching "${q}")`);
    db.close();
    return;
  }
  const symbols = db.prepare('SELECT name, kind, start_line, end_line, exported FROM symbols WHERE file_id = ? ORDER BY start_line').all(f.id);
  const imports = db.prepare('SELECT source FROM imports WHERE file_id = ? ORDER BY line').all(f.id).map((i) => i.source);
  const refsIn = db.prepare('SELECT COUNT(*) c FROM refs r WHERE r.file_id = ?').get(f.id).c;
  console.log(banner(`CONTEXT — ${f.path}`));
  console.log(`  ${f.lang} · ${f.lines} L · ${humanSize(f.size)} · ${refsIn} refs from other files`);
  console.log('');
  list(`symbols (${symbols.length})`, symbols.map((s) => `${s.name} (${s.kind}) ${s.start_line}-${s.end_line}${s.exported ? ' *' : ''}`)).forEach((l) => console.log('  ' + l));
  console.log('');
  list(`imports (${imports.length})`, imports.slice(0, 15)).forEach((l) => console.log('  ' + l));
  db.close();
}

function cmdStats(positional, flags) {
  const dbExists = fs.existsSync(dbPathFor(flags.root));
  const db = openProjectDb(flags.root);
  const files = db.prepare('SELECT COUNT(*) c FROM files').get().c;
  const symbols = db.prepare('SELECT COUNT(*) c FROM symbols').get().c;
  const refs = db.prepare('SELECT COUNT(*) c FROM refs').get().c;
  const imports = db.prepare('SELECT COUNT(*) c FROM imports').get().c;
  const semantic = getMeta(db, 'semantic_pass');
  const last = getMeta(db, 'last_index_ms');
  const big = db.prepare('SELECT path, lines FROM files ORDER BY lines DESC LIMIT 5').all();
  db.close();
  console.log(banner(`ARGUS STATS — ${norm(flags.root)}`));
  console.log(`  index:        ${dbExists ? `ok (${humanSize(fs.statSync(dbPathFor(flags.root)).size)})` : 'missing — run `argus index`'}`);
  console.log(`  files:        ${files}`);
  console.log(`  symbols:      ${symbols}`);
  console.log(`  refs:         ${refs}${semantic === '1' ? '  (semantic pass: yes)' : '  (import-level only — run `argus index --semantic`)'}`);
  console.log(`  imports:      ${imports}`);
  console.log(`  last indexed: ${last ? new Date(Number(last)).toISOString() : 'never'}`);
  console.log(`  initialized:  ${isInitialized(flags.root) ? 'yes (AGENTS.md has argus block)' : 'no — run `argus init`'}`);
  console.log('');
  console.log('  largest files:');
  big.forEach((b) => console.log(`    ${b.path} — ${b.lines} L`));
}

function cmdHelp() {
  console.log(
    'ARGUS — hundred-eyed repository navigator\n' +
    'usage: argus <command> [args] [--root <dir>] [--force] [--semantic] [--depth N] [--agents a,b,c]\n' +
    '\n' +
    '  shim          install a bare `argus` command on PATH (no node prefix needed)\n' +
    '  init          index + shim + write AGENTS.md/per-agent rules   [--no-shim to skip]\n' +
    '  index         build the SQLite index (.opencode/repo-index.sqlite)\n' +
    '  map           file tree with languages + sizes\n' +
    '  search <q>    symbols + files matching query\n' +
    '  symbol <n>    definition + callers + dependencies card\n' +
    '  callers <n>   precise call sites (after index --semantic)\n' +
    '  dependencies <n>  one-level module graph\n' +
    '  impact <n>    DIRECT / INDIRECT affected files  [--depth N]\n' +
    '  source <n>    EXACT line ranges to read (then `read` only those)\n' +
    '  source --file <path>  file read guidance\n' +
    '  context <f>   structural summary of a file (no raw code)\n' +
    '  stats         index health + repo initialization state\n' +
    '  help          this text\n'
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    cmdHelp();
    return;
  }
  const cmd = args.shift();
  const { flags, positional } = parseArgs(args);

  if (!fs.existsSync(flags.root)) {
    console.log(`  ! root does not exist: ${flags.root}`);
    return;
  }

  switch (cmd) {
    case 'init': {
      const cliName = flags.noShim ? undefined : 'argus';
      const r = indexRepo(flags.root, {});
      await r;
      const written = initProject(flags.root, SKILL_ROOT, flags.agents, cliName);
      console.log(banner('ARGUS INIT'));
      written.forEach((w) => console.log(`  ✓ ${w}`));
      console.log('\n  any AI agent (Claude, OpenCode, Codex, Cursor, Copilot) will now');
      console.log('  find the index + usage rules on every execution.');
      if (!flags.noShim) {
        const shim = installShim(SCRIPTS_DIR);
        console.log(`\n  ✓ shim installed: 'argus' command → ${shim.binDir}`);
        console.log('    new shells can now run: argus search <query>   (no node prefix needed)');
        console.log('    note: open new terminals or restart your agent so PATH picks it up.');
      }
      console.log(`  CLI: argus <command> (fallback: node ${norm(path.join(SCRIPTS_DIR, 'argus.mjs'))} <command>)`);
      break;
    }
    case 'shim': {
      const { binDir, written } = installShim(SCRIPTS_DIR);
      console.log(banner('ARGUS SHIM'));
      written.forEach((w) => console.log(`  ✓ ${w}`));
      console.log(`\n  bin dir: ${binDir}`);
      console.log('  now run: argus <command>  (open a new terminal first)');
      break;
    }
    case 'index':
      await cmdIndex(positional, flags);
      break;
    case 'map':
      cmdMap(positional, flags);
      break;
    case 'search':
      cmdSearch(positional, flags);
      break;
    case 'symbol':
      cmdSymbol(positional, flags);
      break;
    case 'callers':
      cmdCallers(positional, flags);
      break;
    case 'dependencies':
      cmdDependencies(positional, flags);
      break;
    case 'impact':
      cmdImpact(positional, flags);
      break;
    case 'source':
      cmdSource(positional, flags);
      break;
    case 'context':
      cmdContext(positional, flags);
      break;
    case 'stats':
      cmdStats(positional, flags);
      break;
    default:
      console.log(`unknown command: ${cmd}`);
      cmdHelp();
  }
}

main().catch((e) => {
  console.error('argus error:', e);
  process.exit(1);
});