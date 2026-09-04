import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildRelease, containsCredentialLeak, isNonRuntimePath, parseCommitMessage } from './release-notes.mjs';

const validMessage = `fix(chat): убрать скачок прокрутки

Patch-Note:
- Чат теперь стабильно остаётся у последнего сообщения.
- Изображения больше не вызывают скачок прокрутки.

Verification:
- npm run typecheck
- npm run build`;

const scriptPath = fileURLToPath(new URL('./release-notes.mjs', import.meta.url));

function run(cwd, command, args) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function git(cwd, args) {
  return run(cwd, 'git', args);
}

function commitFile(repo, relativePath, content, subject, body) {
  const absolutePath = join(repo, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  git(repo, ['add', '--', relativePath]);
  git(repo, ['commit', '-m', subject, '-m', body]);
  return git(repo, ['rev-parse', 'HEAD']);
}

test('extracts only explicit user-facing patch notes', () => {
  const parsed = parseCommitMessage(validMessage, 'valid');
  assert.equal(parsed.skipped, false);
  assert.deepEqual(parsed.notes, [
    'Чат теперь стабильно остаётся у последнего сообщения.',
    'Изображения больше не вызывают скачок прокрутки.',
  ]);
});

test('accepts an explicit non-runtime skip', () => {
  const parsed = parseCommitMessage(`docs: описать релизный процесс

Patch-Note: skip

Verification:
- Документация проверена вручную`, 'skip');
  assert.equal(parsed.skipped, true);
  assert.deepEqual(parsed.notes, []);
});

test('allows skip only for documented policy, hook and test paths', () => {
  assert.equal(isNonRuntimePath('.githooks/commit-msg'), true);
  assert.equal(isNonRuntimePath('.gitmessage'), true);
  assert.equal(isNonRuntimePath('scripts/release-notes.mjs'), true);
  assert.equal(isNonRuntimePath('apps/server/release-notes-test.js'), true);
  assert.equal(isNonRuntimePath('apps/web/src/engine.test.ts'), true);
  assert.equal(isNonRuntimePath('apps/server/index.js'), false);
  assert.equal(isNonRuntimePath('docker-compose.yml'), false);
});

test('rejects messages without verification evidence', () => {
  assert.throws(() => parseCommitMessage(`fix(chat): тест

Patch-Note:
- Чат стал заметно стабильнее при загрузке.`, 'missing'), /Verification/u);
});

test('requires Patch-Note before exactly one meaningful Verification block', () => {
  assert.throws(() => parseCommitMessage(`fix(chat): тест

Verification:
- npm run build

Patch-Note:
- Чат стал заметно стабильнее при загрузке.`, 'wrong-order'), /перед Verification/u);
  assert.throws(() => parseCommitMessage(`${validMessage}

Verification:
- npm run test`, 'duplicate-verification'), /ровно один блок Verification/u);
  assert.throws(() => parseCommitMessage(`fix(chat): тест

Patch-Note:
- Чат стал заметно стабильнее при загрузке.

Verification:
- x`, 'weak-verification'), /осмысленный пункт|формальный placeholder/u);
});

test('rejects internal paths and possible secrets in public notes', () => {
  assert.throws(() => parseCommitMessage(`fix(chat): тест

Patch-Note:
- Исправлена прокрутка в файле apps/web/src/engine.ts, внутренний token удалён.

Verification:
- npm run typecheck`, 'unsafe'), /внутренние данные/u);
});

test('rejects IP, SHA, domain, high-entropy and hidden data in public notes', () => {
  const unsafeNotes = [
    'Сервер теперь доступен по адресу 155.212.167.14 для всех участников.',
    'Служебный номер этого обновления равен aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa и не должен быть виден участникам.',
    'Описание обновления опубликовано на reelay.online для всех участников.',
    `Для подключения использовано значение ${'A1b2C3d4E5f6G7h8J9k0L1m2N3o4P5q6'}.`,
    'В карточке скрыт\u202eопасный служебный фрагмент для участников.',
  ];
  for (const [index, note] of unsafeNotes.entries()) {
    assert.throws(() => parseCommitMessage(`fix(chat): тест

Patch-Note:
- ${note}

Verification:
- npm run typecheck`, `unsafe-${index}`), /внутренние данные|скрытые символы/u);
  }
});

test('rejects mass mentions in public notes', () => {
  assert.throws(() => parseCommitMessage(`fix(chat): тест

Patch-Note:
- В системной карточке появилось массовое упоминание @все для участников.

Verification:
- npm run typecheck`, 'mention'), /массовые упоминания/u);
});

test('rejects a mostly English note with decorative Cyrillic', () => {
  assert.throws(() => parseCommitMessage(`fix(chat): тест

Patch-Note:
- Updated scroll behavior and image loading, теперь.

Verification:
- npm run typecheck`, 'english'), /на русском языке/u);
});

test('does not confuse a normal Russian word with a secret key', () => {
  const parsed = parseCommitMessage(`feat(chat): включить карточки

Patch-Note:
- Включена красивая карточка с описанием обновления.

Verification:
- npm run typecheck`, 'russian-word');
  assert.equal(parsed.notes.length, 1);
});

test('aggregates commits in order and removes duplicate notes', () => {
  const first = parseCommitMessage(validMessage, 'first');
  const second = parseCommitMessage(`perf(chat): ускорить список

Patch-Note:
- Чат теперь стабильно остаётся у последнего сообщения.
- Длинная история открывается заметно быстрее.

Verification:
- npm run build`, 'second');
  const release = buildRelease([
    { ...first, paths: ['apps/web/src/engine.ts'] },
    { ...second, paths: ['apps/native/src-tauri/src/main.rs'] },
  ], { sha: 'a'.repeat(40), source: 'web' });
  assert.equal(release.publish, true);
  assert.equal(release.owner, 'web');
  assert.equal(release.announce, true);
  assert.deepEqual(release.requiredComponents, ['web', 'desktop']);
  assert.deepEqual(release.notes, [
    'Чат теперь стабильно остаётся у последнего сообщения.',
    'Изображения больше не вызывают скачок прокрутки.',
    'Длинная история открывается заметно быстрее.',
  ]);
});

test('routes native-only notes to desktop and relay-core notes to both components', () => {
  const parsed = parseCommitMessage(validMessage, 'routing');
  const desktop = buildRelease([{ ...parsed, paths: ['apps/native/src/main.ts'] }], { source: 'desktop' });
  assert.equal(desktop.owner, 'desktop');
  assert.equal(desktop.announce, true);
  assert.deepEqual(desktop.requiredComponents, ['desktop']);

  const shared = buildRelease([{ ...parsed, paths: ['apps/relay-core/src/lib.rs'] }], { source: 'desktop' });
  assert.equal(shared.owner, 'web');
  assert.equal(shared.announce, true);
  assert.deepEqual(shared.requiredComponents, ['web', 'desktop']);

  const manual = buildRelease([{ ...parsed, paths: ['apps/web/src/engine.ts'] }], { source: 'manual' });
  assert.equal(manual.announce, true);
  assert.deepEqual(manual.requiredComponents, ['manual']);
});

test('CLI validates and aggregates every commit from a multi-commit push in order', () => {
  const repo = mkdtempSync(join(tmpdir(), 'relay-release-notes-'));
  try {
    git(repo, ['init', '--quiet']);
    git(repo, ['config', 'user.name', 'Relay CI Test']);
    git(repo, ['config', 'user.email', 'relay-ci@example.invalid']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    git(repo, ['config', 'core.hooksPath', '.no-hooks']);

    const base = commitFile(repo, 'docs/base.md', 'base\n', 'docs: добавить основу', `Patch-Note: skip

Verification:
- Документация проверена вручную`);
    commitFile(repo, 'apps/web/first.txt', 'first\n', 'fix(chat): исправить историю', `Patch-Note:
- История чата теперь открывается без заметного скачка.

Verification:
- npm run typecheck`);
    const head = commitFile(repo, 'apps/native/second.txt', 'second\n', 'feat(desktop): улучшить обновление', `Patch-Note:
- Настольное приложение теперь обновляется заметно надёжнее.

Verification:
- npm run build`);

    const validation = run(repo, process.execPath, [scriptPath, 'validate', '--from', base, '--to', head]);
    assert.match(validation, /Проверено коммитов: 2/u);

    const output = join(repo, 'release.json');
    run(repo, process.execPath, [scriptPath, 'generate', '--from', base, '--to', head, '--source', 'web', '--output', output]);
    const release = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(release.commits, 2);
    assert.equal(release.owner, 'web');
    assert.equal(release.announce, true);
    assert.deepEqual(release.requiredComponents, ['web', 'desktop']);
    assert.deepEqual(release.notes, [
      'История чата теперь открывается без заметного скачка.',
      'Настольное приложение теперь обновляется заметно надёжнее.',
    ]);

    const redeployOutput = join(repo, 'redeploy.json');
    run(repo, process.execPath, [scriptPath, 'generate', '--from', base, '--to', head, '--source', 'web', '--no-announce', '--output', redeployOutput]);
    assert.equal(JSON.parse(readFileSync(redeployOutput, 'utf8')).announce, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rejects formal Verification placeholders but accepts an explicit reason', () => {
  for (const placeholder of ['TODO', 'done', 'ok', 'Проверено']) {
    assert.throws(() => parseCommitMessage(`fix(chat): тест

Patch-Note:
- Чат теперь работает заметно стабильнее при загрузке.

Verification:
- ${placeholder}`, `verification-${placeholder}`), /формальный placeholder/u);
  }
  const explained = parseCommitMessage(`fix(chat): тест

Patch-Note:
- Чат теперь работает заметно стабильнее при загрузке.

Verification:
- Не запускалось: локально отсутствует Docker`, 'verification-reason');
  assert.equal(explained.notes.length, 1);
});

test('rejects internal identifiers, Windows paths and colon-delimited entropy in public notes', () => {
  const internalFragments = [
    'deploy_releases',
    'apps\\server\\releaseNotes',
    'ABCD:EFGH:IJKL:MNOP:QRST:UVWX:YZ12',
  ];
  for (const fragment of internalFragments) {
    assert.throws(() => parseCommitMessage(`fix(chat): тест

Patch-Note:
- Работа чата стала стабильнее после внутреннего изменения ${fragment}.

Verification:
- npm run typecheck`, `internal-${fragment}`), /внутренние данные/u);
  }
});

test('CLI validates merge commits and fails closed when a nonzero base is unavailable', () => {
  const repo = mkdtempSync(join(tmpdir(), 'relay-release-merge-'));
  try {
    git(repo, ['init', '--quiet', '--initial-branch=main']);
    git(repo, ['config', 'user.name', 'Relay CI Test']);
    git(repo, ['config', 'user.email', 'relay-ci@example.invalid']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    git(repo, ['config', 'core.hooksPath', '.no-hooks']);

    const base = commitFile(repo, 'docs/base.md', 'base\n', 'docs: добавить основу', `Patch-Note: skip

Verification:
- Документация проверена вручную`);
    git(repo, ['switch', '-c', 'feature']);
    commitFile(repo, 'apps/web/feature.txt', 'feature\n', 'feat(chat): добавить улучшение', `Patch-Note:
- Работа чата стала заметно стабильнее после обновления.

Verification:
- npm run typecheck`);
    git(repo, ['switch', 'main']);
    git(repo, ['merge', '--no-ff', 'feature', '-m', 'ci: объединить ветку', '-m', `Patch-Note: skip

Verification:
- npm run typecheck`]);
    const head = git(repo, ['rev-parse', 'HEAD']);

    let mergeError;
    try { run(repo, process.execPath, [scriptPath, 'validate', '--from', base, '--to', head]); }
    catch (error) { mergeError = error; }
    assert.ok(mergeError);
    assert.match(String(mergeError.stderr), /Patch-Note: skip запрещён/u);

    let missingBaseError;
    try { run(repo, process.execPath, [scriptPath, 'validate', '--from', 'f'.repeat(40), '--to', head]); }
    catch (error) { missingBaseError = error; }
    assert.ok(missingBaseError);
    assert.match(String(missingBaseError.stderr), /Базовый коммит .* недоступен/u);

    const mergeNote = 'Слияние сохраняет отдельные улучшения и исправления конфликтов.';
    git(repo, ['commit', '--amend', '-m', 'fix(chat): завершить слияние', '-m', `Patch-Note:
- ${mergeNote}

Verification:
- npm run typecheck`]);
    const amendedHead = git(repo, ['rev-parse', 'HEAD']);
    const output = join(repo, 'merge-release.json');
    run(repo, process.execPath, [scriptPath, 'generate', '--from', base, '--to', amendedHead, '--source', 'web', '--output', output]);
    const generated = JSON.parse(readFileSync(output, 'utf8'));
    const headCandidate = generated.commitCandidates.find((candidate) => candidate.sha === amendedHead);
    assert.ok(headCandidate);
    assert.ok(headCandidate.notes.includes(mergeNote));
    assert.ok(headCandidate.components.includes('web'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('detects typical credentials in added lines without rejecting placeholders or secret references', () => {
  assert.equal(containsCredentialLeak(`GIPHY_${'API'}_KEY=${'A1b2C3d4E5f6G7h8J9k0L1m2N3o4P5q6'}`), true);
  assert.equal(containsCredentialLeak(`password: ${'CorrectHorseBatteryStaple42'}`), true);
  assert.equal(containsCredentialLeak(`const key = "${'ghp'}_${'0123456789abcdefghijklmnop'}";`), true);
  assert.equal(containsCredentialLeak('SESSION_SECRET=dev-secret-change'), false);
  assert.equal(containsCredentialLeak('key: ${{ secrets.SSH_KEY }}'), false);
});
