export function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function hr(width = 60) {
  return '─'.repeat(width);
}

export function banner(title) {
  return `\n${title}\n${hr()}`;
}

export function list(heading, items, indent = '') {
  if (items.length === 0) return [`${heading} (none)`];
  const out = [`${heading}`];
  items.forEach((it, i) => {
    const last = i === items.length - 1;
    out.push(`${indent}${last ? '└─' : '├─'} ${it}`);
  });
  return out;
}

export function renderBlock(title, lines) {
  const out = [banner(title)];
  out.push(...lines.map((l) => `  ${l}`));
  return out.join('\n');
}