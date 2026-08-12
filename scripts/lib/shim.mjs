import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

export function shimBinDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'argus', 'bin');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

export function installShim(scriptsDir) {
  const cli = path.join(scriptsDir, 'argus.mjs');
  const binDir = shimBinDir();
  fs.mkdirSync(binDir, { recursive: true });
  const written = [];

  if (process.platform === 'win32') {
    const cmd = `@echo off\r\nnode "${cli}" %*\r\n`;
    fs.writeFileSync(path.join(binDir, 'argus.cmd'), cmd);
    const ps1 = `& node "${cli}" @args\r\nexit $LASTEXITCODE\r\n`;
    fs.writeFileSync(path.join(binDir, 'argus.ps1'), ps1);
    written.push('argus.cmd', 'argus.ps1');

    const cur = process.env.Path || '';
    if (!cur.split(';').some((p) => p.trim().toLowerCase() === binDir.toLowerCase())) {
      try {
        const esc = binDir.replace(/'/g, "''");
        const out = execSync(
          `powershell -NoProfile -Command "$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p -notlike '*${esc}*') { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';${esc}'), 'User'); 'PATH_UPDATED' } else { 'PATH_EXISTS' }"`,
          { encoding: 'utf8' }
        ).trim();
        written.push(`PATH ('${out}')`);
      } catch {
        written.push('PATH (manual update needed)');
      }
    } else {
      written.push('PATH (already present)');
    }
  } else {
    const sh = `#!/usr/bin/env sh\nexec node "${cli}" "$@"\n`;
    fs.writeFileSync(path.join(binDir, 'argus'), sh, { mode: 0o755 });
    written.push('argus');
    const rc = path.join(os.homedir(), '.bashrc');
    if (fs.existsSync(rc)) {
      const content = fs.readFileSync(rc, 'utf8');
      if (!content.includes(binDir)) {
        fs.appendFileSync(rc, `\nexport PATH="$PATH:${binDir}"\n`);
        written.push('.bashrc PATH export');
      }
    }
  }

  return { binDir, written };
}