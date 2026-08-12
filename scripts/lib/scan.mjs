import fs from 'node:fs';
import path from 'node:path';

export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next',
  '.nuxt', 'coverage', '.turbo', '.cache', 'cache', 'vendor', 'target',
  'bin', 'obj', '.venv', 'venv', 'generated', 'gen', 'assets', 'static',
  'public', '.angular', '.idea', '.vscode', 'Pods', '.dart_tool', '__pycache__',
  '.gradle', '.mvn', 'tmp', 'temp', 'logs', 'prototypes', 'plans',
]);

export const SKIP_FILE_SUFFIX_RE =
  /(\.min\.js$|\.min\.css$|\.map$|\.d\.ts$|\.lock$|\.log$|\.sqlite$|\.sqlite3$|\.db$)$/i;

export function isValidSourceFile(filePath) {
  return extLang(filePath) != null && !SKIP_FILE_SUFFIX_RE.test(filePath);
}

export const LANG_BY_EXT = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx',
  '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx',
  '.php': 'php', '.py': 'py', '.java': 'java', '.cs': 'cs',
  '.go': 'go', '.rb': 'rb', '.vue': 'vue', '.svelte': 'svelte',
};

const MAX_FILE_BYTES = 2_500_000;

export function extLang(filePath) {
  return LANG_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

export function walkFiles(rootDir) {
  const out = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const dir = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(full);
      } else if (entry.isFile()) {
        if (extLang(full) == null) continue;
        out.push(full);
      }
    }
  }
  return out;
}

export function fileStats(filePath) {
  const st = fs.statSync(filePath);
  return { size: st.size, mtime: Math.floor(st.mtimeMs) };
}

export function countLines(src) {
  let n = 1;
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) n++;
  }
  return n;
}

export function readSource(filePath, maxBytes = MAX_FILE_BYTES) {
  const st = fs.statSync(filePath);
  if (st.size > maxBytes) return null;
  return fs.readFileSync(filePath, 'utf8');
}