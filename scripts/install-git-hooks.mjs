#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  try { fs.chmodSync('.githooks/commit-msg', 0o755); } catch { /** Windows uses the tracked executable bit. */ }
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
  execFileSync('git', ['config', '--local', 'commit.template', '.gitmessage'], { stdio: 'inherit' });
  console.log('Git hooks и шаблон RelayApp включены: некорректный Patch-Note нельзя закоммитить.');
} catch (error) {
  console.error(`Не удалось включить Git hooks: ${error.message}`);
  process.exitCode = 1;
}
