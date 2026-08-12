import { createRequire } from 'node:module';
import path from 'node:path';
import { setMeta } from './db.mjs';

const require = createRequire(import.meta.url);

export function resolveTypeScript() {
  try {
    require.resolve('typescript');
    return true;
  } catch {
    return false;
  }
}

function isDeclarationName(node, K) {
  const p = node.parent;
  if (!p) return false;
  switch (p.kind) {
    case K.VariableDeclaration:
    case K.FunctionDeclaration:
    case K.ClassDeclaration:
    case K.InterfaceDeclaration:
    case K.TypeAliasDeclaration:
    case K.EnumDeclaration:
    case K.ModuleDeclaration:
    case K.Parameter:
    case K.PropertyDeclaration:
    case K.PropertySignature:
    case K.MethodDeclaration:
    case K.MethodSignature:
    case K.GetAccessor:
    case K.SetAccessor:
    case K.ImportSpecifier:
    case K.ImportDefaultSpecifier:
    case K.ImportNamespaceSpecifier:
    case K.ExportSpecifier:
    case K.TypeParameter:
    case K.BindingElement:
    case K.EnumMember:
    case K.Constructor:
      return true;
    default:
      return false;
  }
}

function toRel(absPath, rootDir) {
  return path.relative(rootDir, absPath).split('\\').join('/');
}

export function analyzeSemantic(db, files, rootDir, onProgress) {
  const ts = require('typescript');
  const absToRel = new Map();
  const relToId = new Map();
  const rootNames = [];

  for (const f of files) {
    if (!/\.tsx?$/.test(f.path)) continue;
    const abs = path.join(rootDir, f.path);
    absToRel.set(abs.split('\\').join('/'), f.path);
    relToId.set(f.path, f.id);
    rootNames.push(abs);
  }
  if (rootNames.length === 0) return 0;

  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: false,
    skipLibCheck: true,
  };
  const program = ts.createProgram({ rootNames, options });
  const checker = program.getTypeChecker();

  const symbolIds = new Map();
  for (const s of db.prepare('SELECT id, name, file_id FROM symbols').all()) {
    symbolIds.set(s.name, s);
  }

  const refs = [];
  const seen = new Set();
  const refInsert = db.prepare(
    'INSERT OR IGNORE INTO refs(file_id, symbol_id, name, line, kind) VALUES(?,?,?,?,?)'
  );
  const lineInfo = new Map();

  function visit(node, sf, sfRel) {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      const target = symbolIds.get(name);
      if (target && !isDeclarationName(node, ts.SyntaxKind)) {
        const sym = checker.getSymbolAtLocation(node);
        if (sym) {
          const syms = [sym];
          if (sym.aliasSymbol) syms.push(sym.aliasSymbol);
          else if (sym.flags & ts.SymbolFlags.Alias) {
            try {
              syms.push(checker.getAliasedSymbol(sym));
            } catch {
              /* unresolved alias */
            }
          }
          for (const s of syms) {
            if (!s.declarations) continue;
            for (const decl of s.declarations) {
              const dRel = absToRel.get(decl.getSourceFile().fileName.split('\\').join('/'));
              if (!dRel) continue;
              const dId = relToId.get(dRel);
              const cand = target.file_id === dId ? target : null;
              if (!cand) continue;
              const start = node.getStart(sf);
              let line = lineInfo.get(sf);
              if (line === undefined) {
                line = new Map();
                lineInfo.set(sf, line);
              }
              let L = line.get(start);
              if (L === undefined) {
                L = ts.getLineAndCharacterOfPosition(sf, start).line + 1;
                line.set(start, L);
              }
              const key = `${sfRel}:${cand.id}:${L}`;
              if (seen.has(key)) continue;
              seen.add(key);
              refs.push([relToId.get(sfRel), cand.id, name, L, 'semantic']);
              break;
            }
          }
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, sf, sfRel));
  }

  let processed = 0;
  for (const sf of program.getSourceFiles()) {
    const abs = sf.fileName.split('\\').join('/');
    const rel = absToRel.get(abs);
    if (!rel) continue;
    if (onProgress) onProgress(++processed, rootNames.length);
    try {
      visit(sf, sf, rel);
    } catch {
      /* skip node that caused an error */
    }
  }

  db.exec('BEGIN');
  for (const r of refs) refInsert.run(...r);
  db.exec('COMMIT');
  setMeta(db, 'semantic_pass', '1');
  return refs.length;
}