import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  lang TEXT,
  size INTEGER,
  lines INTEGER,
  mtime INTEGER
);
CREATE TABLE IF NOT EXISTS symbols(
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  exported INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS imports(
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  names TEXT NOT NULL DEFAULT '[]',
  line INTEGER,
  resolved_id INTEGER REFERENCES files(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS refs(
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  line INTEGER,
  kind TEXT NOT NULL DEFAULT 'import'
);
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source);
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_id);
CREATE INDEX IF NOT EXISTS idx_refs_symbol ON refs(symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
`;

export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

export function replaceFileRows(db, fileId) {
  db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM imports WHERE file_id = ?').run(fileId);
  db.prepare(
    'DELETE FROM refs WHERE file_id = ? AND kind != ?'
  ).run(fileId, 'semantic');
}

export function upsertFile(db, path, lang, size, lines, mtime) {
  const row = db
    .prepare('SELECT id, mtime FROM files WHERE path = ?')
    .get(path);
  if (row) {
    db.prepare(
      'UPDATE files SET lang=?, size=?, lines=?, mtime=? WHERE id=?'
    ).run(lang, size, lines, mtime, row.id);
    return { id: row.id, changed: row.mtime !== mtime };
  }
  const res = db
    .prepare(
      'INSERT INTO files(path, lang, size, lines, mtime) VALUES(?,?,?,?,?)'
    )
    .run(path, lang, size, lines, mtime);
  return { id: Number(res.lastInsertRowid), changed: true };
}

export function removeMissingFiles(db, presentPaths) {
  const rows = db.prepare('SELECT id, path FROM files').all();
  for (const row of rows) {
    if (!presentPaths.has(row.path)) {
      db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    }
  }
  return rows.length - presentPaths.size > 0 ? true : false;
}

export function insertSymbol(db, fileId, name, kind, startLine, endLine, exported) {
  const res = db
    .prepare(
      'INSERT INTO symbols(file_id, name, kind, start_line, end_line, exported) VALUES(?,?,?,?,?,?)'
    )
    .run(fileId, name, kind, startLine, endLine, exported ? 1 : 0);
  return Number(res.lastInsertRowid);
}

export function insertImport(db, fileId, source, names, line, resolvedId) {
  const res = db
    .prepare(
      'INSERT INTO imports(file_id, source, names, line, resolved_id) VALUES(?,?,?,?,?)'
    )
    .run(fileId, source, JSON.stringify(names), line, resolvedId ?? null);
  return Number(res.lastInsertRowid);
}

export function insertRef(db, fileId, symbolId, name, line, kind = 'import') {
  const existing = db
    .prepare('SELECT id FROM refs WHERE file_id=? AND symbol_id=? AND line=?')
    .get(fileId, symbolId, line);
  if (existing) return;
  db.prepare(
    'INSERT INTO refs(file_id, symbol_id, name, line, kind) VALUES(?,?,?,?,?)'
  ).run(fileId, symbolId, name, line, kind);
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, String(value));
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}