export const JS_LANGS = new Set(['js', 'jsx', 'ts', 'tsx']);

export const LANG_INFO = {
  js:   { kind: 'js',   comment: '//' },
  jsx:  { kind: 'jsx',  comment: '//' },
  ts:   { kind: 'ts',   comment: '//' },
  tsx:  { kind: 'tsx',  comment: '//' },
  php:  { kind: 'php',  comment: '//' },
  py:   { kind: 'py',   comment: '#'  },
  java: { kind: 'java', comment: '//' },
  cs:   { kind: 'cs',   comment: '//' },
  go:   { kind: 'go',   comment: '//' },
  rb:   { kind: 'rb',   comment: '#'  },
  vue:  { kind: 'vue',  comment: '//' },
  svelte: { kind: 'svelte', comment: '//' },
};

export function languageKind(lang) {
  return LANG_INFO[lang]?.kind ?? lang;
}

export function componentFile(lang) {
  return lang === 'tsx' || lang === 'jsx';
}

export function isPascalCase(name) {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(name);
}

export function isLikelyComponent(name, kind, lang) {
  if (!componentFile(lang)) return false;
  if (!isPascalCase(name)) return false;
  return kind === 'function' || kind === 'arrow' || kind === 'class' || kind === 'const';
}