import { JS_LANGS, isLikelyComponent } from './lang.mjs';

export function maskSource(src) {
  return maskGeneric(src, true);
}

export function maskComments(src) {
  return maskGeneric(src, false);
}

function maskGeneric(src, blankStrings) {
  const out = new Array(src.length);
  const kinds = { state: 0, line: 1, block: 2, str: 3, tpl: 4 };
  let state = kinds.state;
  let quote = '';

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    switch (state) {
      case kinds.state:
        if (c === '/' && n === '/') {
          state = kinds.line; out[i] = ' '; continue;
        }
        if (c === '/' && n === '*') {
          state = kinds.block; out[i] = ' '; out[i + 1] = ' '; i++; continue;
        }
        if (c === '"' || c === "'") {
          state = kinds.str; quote = c; out[i] = blankStrings ? ' ' : c; continue;
        }
        if (c === '`') {
          state = kinds.tpl; out[i] = blankStrings ? ' ' : c; continue;
        }
        out[i] = c;
        break;
      case kinds.line:
        out[i] = c === '\n' || c === '\r' ? c : ' ';
        if (c === '\n') state = kinds.state;
        break;
      case kinds.block:
        out[i] = c === '\n' || c === '\r' ? c : ' ';
        if (c === '*' && n === '/') {
          out[i + 1] = ' '; i++; state = kinds.state;
        }
        break;
      case kinds.str:
        out[i] = blankStrings ? (c === '\n' || c === '\r' ? c : ' ') : c;
        if (c === '\\') { if (!blankStrings) out[i + 1] = c; else out[i + 1] = ' '; i++; continue; }
        if (c === quote) state = kinds.state;
        break;
      case kinds.tpl:
        out[i] = blankStrings ? (c === '\n' || c === '\r' ? c : ' ') : c;
        if (c === '\\') { if (!blankStrings) out[i + 1] = c; else out[i + 1] = ' '; i++; continue; }
        if (c === '`') state = kinds.state;
        break;
    }
  }
  return out.join('');
}

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function isExported(mask, index) {
  const start = mask.lastIndexOf(';', index - 1);
  const seg = mask.slice(start + 1, index);
  return /\bexport\b/.test(seg);
}

function scanBraces(mask, from) {
  const open = mask.indexOf('{', from);
  if (open === -1) return -1;
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    const c = mask[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function scanBody(mask, from) {
  let paren = 0;
  let opened = false;
  let depth = 0;
  for (let i = from; i < mask.length; i++) {
    const c = mask[i];
    if (c === '(') { paren++; continue; }
    if (c === ')') { if (paren > 0) paren--; continue; }
    if (c === '{' && paren === 0) {
      opened = true;
      depth++;
    } else if (c === '}' && opened && paren === 0) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function jsSymbols(src, mask) {
  const symbols = [];
  const decls = [
    { kind: 'function', re: /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'class', re: /\bclass\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'interface', re: /\binterface\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'enum', re: /\benum\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'type', re: /\btype\s+([A-Za-z_$][\w$]*)\s*=/g },
    { kind: 'arrow', re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^;=\n]*?)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g },
    { kind: 'const', re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^;=\n]*?)?\s*=/g },
  ];
  const seen = new Map();
  for (const { kind, re } of decls) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(mask)) !== null) {
      const name = m[1];
      const idx = m.index;
      if (seen.has(name)) continue;
      let end = -1;
      if (kind === 'function' || kind === 'class' || kind === 'arrow') {
        const afterName = idx + m[0].indexOf(name) + name.length;
        end = scanBody(mask, afterName);
        if (end === -1 && kind === 'arrow') end = mask.indexOf(';', idx);
      } else if (kind === 'interface' || kind === 'enum') {
        const open = mask.indexOf('{', idx);
        end = open !== -1 ? scanBraces(mask, open) : mask.indexOf(';', idx);
      } else if (kind === 'type') {
        end = mask.indexOf(';', idx);
      } else if (kind === 'arrow') {
        end = mask.indexOf(';', idx);
      } else {
        end = mask.indexOf(';', idx);
      }
      if (end === -1) end = idx;
      const exported = isExported(mask, idx) ? 1 : 0;
      seen.set(name, { kind, start: lineAt(src, idx), end: lineAt(src, end), exported });
    }
  }
  for (const [name, info] of seen) {
    symbols.push({ ...info, name });
  }
  return symbols;
}

function phpSymbols(src, mask) {
  const symbols = [];
  const re = /(?:public|private|protected|static|final)?\s*(?:function\s+([A-Za-z_][\w]*)|(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_][\w]*))/g;
  let m;
  while ((m = re.exec(mask)) !== null) {
    const name = m[1] || m[2];
    if (!name) continue;
    const kind = m[1] ? 'function' : m[2] ? 'class' : 'function';
    const idx = m.index;
    let end = -1;
    if (kind === 'class') {
      const open = mask.indexOf('{', idx);
      end = open !== -1 ? scanBraces(mask, open) : idx;
    } else {
      end = mask.indexOf('{', idx);
      if (end === -1) end = mask.indexOf(';', idx);
      if (end !== -1) {
        const close = scanBraces(mask, end);
        end = close !== -1 ? close : end;
      }
    }
    symbols.push({ name, kind, start: lineAt(src, idx), end: lineAt(src, end === -1 ? idx : end), exported: isExported(mask, idx) ? 1 : 0 });
  }
  return symbols;
}

function pySymbols(src, mask) {
  const symbols = [];
  const lines = src.split('\n');
  const re = /^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/gm;
  let m;
  while ((m = re.exec(mask)) !== null) {
    const name = m[1] || m[2];
    if (!name) continue;
    const kind = m[2] ? 'class' : 'function';
    const idx = m.index;
    const start = lineAt(src, idx);
    let end = start;
    for (let i = start; i < Math.min(lines.length, start + 300); i++) {
      const line = lines[i];
      if (i > start && line.trim() !== '' && !/^\s/.test(line)) break;
      end = i + 1;
    }
    symbols.push({ name, kind, start, end, exported: isExported(mask, idx) ? 1 : 0 });
  }
  return symbols;
}

function javaCsSymbols(src, mask, isCs) {
  const symbols = [];
  const re = new RegExp(
    `(?:public|private|protected|static|final|abstract|sealed|internal)\\s+(class|interface|enum|record)\\s+([A-Za-z_]\\w*)|(?:public|private|protected|internal)\\s+[\\w<>\\[\\],\\s]+\\s([A-Za-z_]\\w*)\\s*\\(`,
    'g'
  );
  let m;
  while ((m = re.exec(mask)) !== null) {
    const typeName = m[1];
    const name = m[2] || m[3];
    if (!name) continue;
    const kind = typeName ? (typeName === 'record' ? 'class' : typeName) : 'method';
    const idx = m.index;
    let end = -1;
    if (kind !== 'method') {
      const open = mask.indexOf('{', idx);
      end = open !== -1 ? scanBraces(mask, open) : mask.indexOf(';', idx);
    } else {
      const open = mask.indexOf('{', idx);
      if (open !== -1 && open - idx < 500) end = scanBraces(mask, open);
      if (end === -1) end = mask.indexOf(';', idx);
    }
    symbols.push({
      name, kind,
      start: lineAt(src, idx),
      end: lineAt(src, end === -1 ? idx : end),
      exported: isExported(mask, idx) ? 1 : 0,
    });
  }
  return symbols;
}

export function extractSymbols(lang, src, mask) {
  if (JS_LANGS.has(lang)) return jsSymbols(src, mask);
  if (lang === 'php') return phpSymbols(src, mask);
  if (lang === 'py') return pySymbols(src, mask);
  if (lang === 'java' || lang === 'cs') return javaCsSymbols(src, mask, lang === 'cs');
  return [];
}

export function extractImports(lang, src, mask) {
  if (!JS_LANGS.has(lang)) return [];
  const code = maskComments(src);
  const imports = [];
  const re = /(?:^|[;\n])\s*import\s+([\s\S]*?)from\s*['"]([^'"]+)['"]|(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]|(?:^|[;\n])\s*import\s*\(|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[0].includes('import(')) {
      const dy = /import\s*\(\s*['"]([^'"]+)['"]/.exec(m[0]);
      if (dy) imports.push({ source: dy[1], names: [], line: lineAt(src, m.index) });
      continue;
    }
    const clause = m[1];
    const source = m[2] || m[3] || m[4];
    const line = lineAt(src, m.index);
    if (source == null) continue;
    const names = [];
    if (clause) {
      const groups = clause
        .replace(/\s+/g, ' ')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      for (const g of groups) {
        const tokens = g.replace(/\*/g, ' ').match(/[A-Za-z_$][\w$]*/g) ?? [];
        const local = tokens.filter((t) => t !== 'as' && t !== 'type' && t !== 'typeof').pop();
        if (local) names.push(local);
      }
    }
    imports.push({ source, names, line });
  }
  return imports;
}