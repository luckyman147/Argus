import fs from 'node:fs';
import path from 'node:path';

const MARK_START = '<!-- argus:start -->';
const MARK_END = '<!-- argus:end -->';

function norm(p) {
  return p.split('\\').join('/');
}

function argusBlock(skillScriptsDir) {
  const cli = `node ${norm(path.join(skillScriptsDir, 'argus.mjs'))}`;
  return [
    `${MARK_START}`,
    `# Argus — repo-navigator (installed by \`argus init\`, keep this block)`,
    ``,
    `Never read entire source files first. Query the repository index, then read only the exact line range:`,
    ``,
    `- Index: \`.opencode/repo-index.sqlite\` — rebuild when it is missing or stale:`,
    `  \`${cli} index\``,
    `- \`${cli} search <query>\`   → symbols + exact line ranges`,
    `- \`${cli} symbol <name>\`    → definition, callers, dependencies summary`,
    `- \`${cli} impact <name>\`    → DIRECT / INDIRECT affected code`,
    `- \`${cli} source <symbol>\`  → exact line range to read — read ONLY those lines`,
    `- \`${cli} context <file>\`   → structural summary of a file, no raw code`,
    ``,
    `Workflow: SEARCH → LOCATE → NARROW → READ → EDIT.`,
    `${MARK_END}`,
  ].join('\n');
}

function upsertBlock(filePath, block) {
  const made = !fs.existsSync(filePath);
  const content = made ? '' : fs.readFileSync(filePath, 'utf8');
  const start = content.indexOf(MARK_START);
  const end = content.indexOf(MARK_END);
  if (start !== -1 && end !== -1) {
    const before = content.slice(0, start);
    const after = content.slice(end + MARK_END.length);
    fs.writeFileSync(filePath, before + block + '\n' + after.replace(/^\n+/, ''));
  } else {
    const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(filePath, content + sep + block + '\n');
  }
  return made ? 'created' : 'updated';
}

function ensureGitignore(projectDir) {
  const gitPath = path.join(projectDir, '.gitignore');
  const entry = '.opencode/repo-index.sqlite';
  let content = fs.existsSync(gitPath) ? fs.readFileSync(gitPath, 'utf8') : '';
  if (!content.split('\n').some((l) => l.trim() === entry)) {
    const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitPath, content + sep + entry + '\n');
  }
}

function cursorRuleFile(skillScriptsDir, projectDir) {
  const cli = `node ${norm(path.join(skillScriptsDir, 'argus.mjs'))}`;
  return `---
description: Query the argus repository index before reading source files
globs: ["**/*"]
---
${MARK_START}
# Argus — repo-navigator
Before reading any file, query the index:
- Index: .opencode/repo-index.sqlite (rebuild: \`${cli} index\`)
- \`${cli} search <query>\` → symbol + exact lines; \`${cli} symbol <name>\` → def/callers/deps
- \`${cli} source <symbol>\` → exact range → read only those lines
Workflow: SEARCH → LOCATE → NARROW → READ → EDIT.
${MARK_END}
`;
}

export function initProject(projectDir, skillRoot, agentTargets) {
  const scriptsDir = path.join(skillRoot, 'scripts');
  fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });

  const agents = Array.isArray(agentTargets) && agentTargets.length > 0
    ? agentTargets
    : ['opencode', 'claude', 'cursor', 'copilot'];

  const written = [];
  const block = argusBlock(scriptsDir);

  const gitPath = path.join(projectDir, '.git');
  if (fs.existsSync(gitPath)) {
    ensureGitignore(projectDir);
    written.push('.gitignore ← .opencode/repo-index.sqlite');
  } else {
    const gi = path.join(projectDir, '.gitignore');
    const s = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!s.includes('.opencode/repo-index.sqlite')) {
      fs.writeFileSync(gi, s + (s.endsWith('\n') || s === '' ? '' : '\n') + '.opencode/repo-index.sqlite\n');
      written.push('.gitignore (created) ← .opencode/repo-index.sqlite');
    }
  }

  const agentsMd = path.join(projectDir, 'AGENTS.md');
  written.push(`AGENTS.md ← ${upsertBlock(agentsMd, block)}`);

  if (agents.includes('claude')) {
    const claudeMd = path.join(projectDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      written.push(`CLAUDE.md ← ${upsertBlock(claudeMd, block)}`);
    } else {
      written.push('CLAUDE.md (skipped — not present; AGENTS.md covers it)');
    }
  }

  if (agents.includes('cursor')) {
    const rulesDir = path.join(projectDir, '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    const f = path.join(rulesDir, 'argus.mdc');
    fs.writeFileSync(f, cursorRuleFile(scriptsDir, projectDir));
    written.push(`.cursor/rules/argus.mdc ← created`);
  }

  if (agents.includes('copilot')) {
    const f = path.join(projectDir, '.github', 'copilot-instructions.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const made = !fs.existsSync(f);
    let content = made ? '' : fs.readFileSync(f, 'utf8');
    if (!content.includes(MARK_START)) {
      const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(f, content + sep + block + '\n');
      written.push(`.github/copilot-instructions.md ← ${made ? 'created' : 'updated'}`);
    } else {
      fs.writeFileSync(f, content.replace(/<!-- argus:start -->[\s\S]*<!-- argus:end -->/, block));
      written.push('.github/copilot-instructions.md ← updated');
    }
  }

  return written;
}

export function isInitialized(projectDir) {
  const md = path.join(projectDir, 'AGENTS.md');
  if (!fs.existsSync(md)) return false;
  const c = fs.readFileSync(md, 'utf8');
  return c.includes(MARK_START) && c.includes(MARK_END);
}