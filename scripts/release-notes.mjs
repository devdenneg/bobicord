#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/i;
const ZERO_SHA_RE = /^0{40}$/;
const COMMIT_HEADER_RE = /^(feat|fix|perf|refactor|chore|docs|test|build|ci|style|revert)(\([a-z0-9._/-]+\))?!?: .+/i;
const SECTION_RE = /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 _-]*:\s*$/u;
const FORBIDDEN_NOTE_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:^|[^a-z0-9])(?:apps\/|src\/|scripts\/|\.github\/|[a-z]:\\|\/[a-z0-9])|(?:^|[^a-z0-9])(?:[a-z0-9_.-]+\\){1,}[a-z0-9_.-]+|\b[a-z][a-z0-9]{1,}(?:_[a-z0-9]{2,})+\b|\b(?:secret|token|password|bearer|private[_ -]?key|api[_ -]?key)\b|(?<![А-Яа-яЁё])(?:секрет(?:ы|а|ов|ом)?|токен(?:ы|а|ов|ом)?|парол(?:ь|и|я|ей|ем)?|ключ(?:и|а|ей|ом)?)(?![А-Яа-яЁё])|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b|(?:^|[^0-9a-f:])(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-f:])|\b(?:[a-z0-9]{4,}:){3,}[a-z0-9]{4,}\b|\b[0-9a-f]{7,40}\b|\b(?:[a-zа-яё0-9](?:[a-zа-яё0-9-]{0,62})\.)+[a-zа-яё]{2,63}\b|`|[a-z0-9_+/=-]{24,})/iu;
const FORBIDDEN_MENTION_RE = /(^|\s)@(?:all|everyone|here|все)(?=$|[\s,!.?:;])/iu;
const WELL_KNOWN_CREDENTIAL_RE = /(?:\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bxox[baprs]-[0-9A-Za-z-]{20,}\b|-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----)/u;
const CREDENTIAL_ASSIGNMENT_RE = /\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|session[_-]?secret|password|passwd|private[_-]?key)\b\s*[:=]\s*["'`]?([A-Za-z0-9_+/=:-]{16,})/iu;
const CREDENTIAL_PLACEHOLDER_RE = /^(?:dev|test|example|sample|placeholder|change|changeme|your[_-]|dummy|local)/iu;
const MAX_NOTE_LENGTH = 200;
const MAX_NOTES_PER_COMMIT = 5;
const MAX_RELEASE_NOTES = 30;
const MAX_RELEASE_CANDIDATES = 256;

function fail(message) {
  throw new Error(message);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function cleanSha(value) {
  const sha = String(value || '').trim();
  return SHA_RE.test(sha) ? sha.toLowerCase() : '';
}

function sectionLines(lines, headerIndex) {
  const out = [];
  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (SECTION_RE.test(line)) break;
    if (!line) continue;
    out.push(line);
  }
  return out;
}

function validateNote(note, label) {
  if (note.length < 8 || note.length > MAX_NOTE_LENGTH) {
    fail(`${label}: пункт Patch-Note должен содержать 8–${MAX_NOTE_LENGTH} символов`);
  }
  const letters = note.match(/[A-Za-zА-Яа-яЁё]/gu) || [];
  const cyrillic = note.match(/[А-Яа-яЁё]/gu) || [];
  if (!cyrillic.length || cyrillic.length / Math.max(1, letters.length) < 0.55) {
    fail(`${label}: Patch-Note должен быть нормальной пользовательской фразой на русском языке`);
  }
  if (/[\p{Cc}\p{Cf}]/u.test(note)) fail(`${label}: Patch-Note содержит управляющие или скрытые символы`);
  if (FORBIDDEN_MENTION_RE.test(note)) fail(`${label}: Patch-Note не должен вызывать массовые упоминания`);
  if (FORBIDDEN_NOTE_RE.test(note)) fail(`${label}: Patch-Note содержит внутренние данные, путь, URL или потенциальный секрет`);
}

function validateVerification(lines, label) {
  if (!lines.length || lines.some((line) => !line.startsWith('- '))) {
    fail(`${label}: Verification должен содержать хотя бы один осмысленный пункт «- …»`);
  }
  for (const line of lines) {
    const item = line.slice(2).trim();
    const normalized = item.replace(/[.!…]+$/u, '').trim().toLocaleLowerCase('ru-RU');
    if (item.length < 8 || !/[\p{L}\p{N}]/u.test(item)
      || /^(?:todo|tbd)(?:\b|:)/iu.test(normalized)
      || /^(?:done|ok(?:ay)?|none|n\/?a|готово|проверено|всё проверено|успешно|нет)$/iu.test(normalized)
      || /^не запускалось\s*$/iu.test(normalized)) {
      fail(`${label}: Verification содержит формальный placeholder вместо выполненной проверки или объяснения причины`);
    }
  }
}

export function containsCredentialLeak(line) {
  const text = String(line || '');
  if (WELL_KNOWN_CREDENTIAL_RE.test(text)) return true;
  const assignment = text.match(CREDENTIAL_ASSIGNMENT_RE);
  return !!assignment && !CREDENTIAL_PLACEHOLDER_RE.test(assignment[1]);
}

function addedLines(diff) {
  return String(diff || '').split(/\r?\n/u)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

function validateCredentialDiff(diff, label) {
  if (addedLines(diff).some((line) => containsCredentialLeak(line))) {
    fail(`${label}: в добавленных строках найдено значение, похожее на учётные данные; секреты нельзя коммитить`);
  }
}

export function parseCommitMessage(message, label = 'commit') {
  const normalized = String(message || '').replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n');
  const subject = (lines[0] || '').trim();
  if (!COMMIT_HEADER_RE.test(subject)) fail(`${label}: заголовок не соответствует Conventional Commits: ${subject || '<пусто>'}`);

  const patchIndexes = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^Patch-Note:/u.test(lines[index].trim())) patchIndexes.push(index);
  }
  if (patchIndexes.length !== 1) fail(`${label}: нужен ровно один блок Patch-Note`);

  const patchLine = lines[patchIndexes[0]].trim();
  const skipped = patchLine === 'Patch-Note: skip';
  if (!skipped && patchLine !== 'Patch-Note:') fail(`${label}: допустимы только «Patch-Note:» или «Patch-Note: skip»`);

  const verificationIndexes = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() === 'Verification:') verificationIndexes.push(index);
  }
  if (verificationIndexes.length !== 1) fail(`${label}: нужен ровно один блок Verification`);
  const verificationIndex = verificationIndexes[0];
  if (patchIndexes[0] > verificationIndex) fail(`${label}: блок Patch-Note должен находиться перед Verification`);
  const intermediateSection = lines.slice(patchIndexes[0] + 1, verificationIndex)
    .find((line) => SECTION_RE.test(line.trim()));
  if (intermediateSection) fail(`${label}: между Patch-Note и Verification не должно быть других секций`);
  const verificationLines = sectionLines(lines, verificationIndex);
  validateVerification(verificationLines, label);

  if (skipped) {
    const unexpected = lines.slice(patchIndexes[0] + 1, verificationIndex).some((line) => line.trim());
    if (unexpected) fail(`${label}: после «Patch-Note: skip» должен сразу следовать блок Verification`);
    return { subject, skipped: true, notes: [] };
  }

  const patchLines = sectionLines(lines, patchIndexes[0]);
  if (!patchLines.length || patchLines.some((line) => !line.startsWith('- '))) {
    fail(`${label}: Patch-Note должен содержать пункты только в формате «- …»`);
  }
  const notes = patchLines.map((line) => line.slice(2).trim());
  if (notes.length > MAX_NOTES_PER_COMMIT) fail(`${label}: в Patch-Note допустимо не более ${MAX_NOTES_PER_COMMIT} пунктов`);
  notes.forEach((note) => validateNote(note, label));
  return { subject, skipped: false, notes };
}

function changedPaths(sha) {
  const output = git(['diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '-r', sha]);
  return output ? output.split(/\r?\n/u).filter(Boolean) : [];
}

export function isNonRuntimePath(file) {
  const normalized = file.replace(/\\/g, '/');
  return normalized === 'AGENTS.md'
    || normalized === 'CLAUDE.md'
    || normalized === 'README.md'
    || normalized === '.gitattributes'
    || normalized === '.gitignore'
    || normalized === '.gitmessage'
    || normalized === 'package.json'
    || normalized === 'package-lock.json'
    || normalized.endsWith('.md')
    || normalized.startsWith('docs/')
    || normalized.startsWith('.githooks/')
    || normalized.startsWith('.github/')
    || normalized.startsWith('scripts/')
    || /(^|\/)(?:test|tests|__tests__)(\/|$)/u.test(normalized)
    || /(?:^|\/)[^/]*(?:[._-](?:test|spec))\.[^/]+$/u.test(normalized)
    || /(?:^|\/)(?:test|spec)\.[^/]+$/u.test(normalized);
}

function commitsInRange(from, to) {
  const target = cleanSha(to) || cleanSha(process.env.RELEASE_SHA) || cleanSha(git(['rev-parse', 'HEAD']));
  if (!target) fail('Не удалось определить конечный SHA релиза');
  const base = cleanSha(from || process.env.RELEASE_FROM);
  if (!base || ZERO_SHA_RE.test(base)) {
    // workflow_dispatch and the initial branch push have no usable base. Validate the exact
    // target commit, including a real merge commit, rather than silently expanding a guessed range.
    return [target];
  }
  if (base === target) return [];
  try {
    git(['cat-file', '-e', `${base}^{commit}`]);
  } catch {
    fail(`Базовый коммит ${base.slice(0, 12)} недоступен; безопасная проверка диапазона невозможна`);
  }
  const output = git(['rev-list', '--reverse', `${base}..${target}`]);
  return output ? output.split(/\r?\n/u).filter(Boolean) : [];
}

function requiredComponents(commits) {
  const files = commits.flatMap((commit) => commit.paths || []).map((file) => file.replace(/\\/g, '/'));
  const web = files.some((file) => file.startsWith('apps/server/')
    || file.startsWith('apps/web/')
    || file.startsWith('apps/relay/')
    || file.startsWith('apps/relay-core/')
    || file.startsWith('coturn/')
    || file === 'docker-compose.yml'
    || file === '.dockerignore'
    || file === '.github/workflows/deploy.yml');
  const desktop = files.some((file) => file.startsWith('apps/native/')
    || file.startsWith('apps/web/')
    || file.startsWith('apps/relay-core/')
    || file === '.github/workflows/build-windows.yml');
  return [web ? 'web' : '', desktop ? 'desktop' : ''].filter(Boolean);
}

function releaseOwner(components) {
  if (components.includes('web')) return 'web';
  if (components.includes('desktop')) return 'desktop';
  return 'none';
}

function notesForCommits(commits) {
  const notes = [];
  const seen = new Set();
  for (const commit of commits) {
    for (const note of commit.notes || []) {
      const key = note.toLocaleLowerCase('ru-RU');
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push(note);
    }
  }
  if (notes.length > MAX_RELEASE_NOTES) {
    const hidden = notes.length - (MAX_RELEASE_NOTES - 1);
    notes.splice(MAX_RELEASE_NOTES - 1, hidden, `И ещё ${hidden} улучшений в этом обновлении.`);
  }
  return notes;
}

function candidateForFirstParentHead(sha) {
  const parents = git(['show', '-s', '--format=%P', sha]).split(/\s+/u).filter(Boolean);
  let contentShas = [sha];
  if (parents.length > 1) {
    const introduced = git(['rev-list', '--reverse', '--no-merges', `${parents[0]}..${sha}`]);
    const introducedShas = introduced ? introduced.split(/\r?\n/u).filter(Boolean) : [];
    contentShas = [...new Set([...introducedShas, sha])];
  }
  const commits = [];
  for (const contentSha of contentShas) {
    try {
      commits.push({
        sha: contentSha,
        paths: contentSha === sha && parents.length > 1
          ? git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-m', contentSha]).split(/\r?\n/u).filter(Boolean)
          : changedPaths(contentSha),
        ...parseCommitMessage(git(['show', '-s', '--format=%B', contentSha]), contentSha.slice(0, 12)),
      });
    } catch {
      // History can predate the policy. It remains an ancestry marker, but cannot inject text.
    }
  }
  return { sha, notes: notesForCommits(commits), components: requiredComponents(commits) };
}

export function buildCommitCandidates(target, release, source = 'web') {
  if (!cleanSha(target)) return [];
  if (source === 'manual') {
    return [{ sha: target, notes: [...release.notes], components: ['manual'] }];
  }
  const output = git(['rev-list', '--first-parent', `--max-count=${MAX_RELEASE_CANDIDATES}`, target]);
  const heads = output ? output.split(/\r?\n/u).filter(Boolean).reverse() : [target];
  const candidates = heads.map(candidateForFirstParentHead);
  let head = candidates.find((candidate) => candidate.sha === target);
  if (!head) {
    head = { sha: target, notes: [], components: [] };
    candidates.push(head);
  }
  const represented = new Set(candidates.flatMap((candidate) => candidate.notes)
    .map((note) => note.toLocaleLowerCase('ru-RU')));
  if (release.notes.some((note) => !represented.has(note.toLocaleLowerCase('ru-RU')))) {
    head.notes = [...release.notes];
    head.components = [...release.requiredComponents];
  }
  return candidates;
}

export function buildRelease(commits, options = {}) {
  const seen = new Set();
  const notes = [];
  for (const commit of commits) {
    for (const note of commit.notes || []) {
      const key = note.toLocaleLowerCase('ru-RU');
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push(note);
    }
  }
  if (notes.length > MAX_RELEASE_NOTES) {
    const hidden = notes.length - (MAX_RELEASE_NOTES - 1);
    notes.splice(MAX_RELEASE_NOTES - 1, hidden, `И ещё ${hidden} улучшений в этом обновлении.`);
  }
  const source = options.source || 'manual';
  const detectedComponents = requiredComponents(commits);
  const components = source === 'manual' ? ['manual'] : detectedComponents;
  const owner = releaseOwner(detectedComponents);
  return {
    schema: 1,
    sha: options.sha || '',
    source,
    owner,
    requiredComponents: components,
    title: 'Обновление RelayApp',
    version: options.version || undefined,
    notes,
    commits: commits.length,
    publish: notes.length > 0,
    announce: notes.length > 0 && components.includes(source),
    attempt: options.attempt || `${options.sha || 'manual'}:1`,
    createdAt: options.createdAt || new Date().toISOString(),
  };
}

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function loadAndValidateCommits(from, to) {
  const shas = commitsInRange(from, to);
  const commits = shas.map((sha) => {
    validateCredentialDiff(git(['show', '-m', '--format=', '--unified=0', '--no-ext-diff', '--no-color', sha]), sha.slice(0, 12));
    const parsed = parseCommitMessage(git(['show', '-s', '--format=%B', sha]), sha.slice(0, 12));
    const paths = changedPaths(sha);
    if (parsed.skipped && paths.some((file) => !isNonRuntimePath(file))) {
      fail(`${sha.slice(0, 12)}: Patch-Note: skip запрещён для поставляемых файлов (${paths.filter((file) => !isNonRuntimePath(file)).slice(0, 3).join(', ')})`);
    }
    return { sha, paths, ...parsed };
  });
  return { shas, commits };
}

function main() {
  const command = process.argv[2] || 'validate';
  if (!['validate', 'validate-message', 'generate'].includes(command)) fail('Использование: release-notes.mjs <validate|validate-message|generate>');
  if (command === 'validate-message') {
    const file = readArg('--file');
    if (!file) fail('Для validate-message нужен --file <commit-message>');
    const parsed = parseCommitMessage(fs.readFileSync(file, 'utf8'), 'новый коммит');
    validateCredentialDiff(git(['diff', '--cached', '--unified=0', '--no-ext-diff', '--no-color', '--diff-filter=ACMR']), 'новый коммит');
    if (parsed.skipped) {
      const staged = git(['diff', '--cached', '--name-only']).split(/\r?\n/u).filter(Boolean);
      const runtime = staged.filter((entry) => !isNonRuntimePath(entry));
      if (runtime.length) fail(`Patch-Note: skip запрещён для поставляемых файлов (${runtime.slice(0, 3).join(', ')})`);
    }
    console.log(`Commit message принят: ${parsed.skipped ? 'патчноут не требуется' : `${parsed.notes.length} пункт(а) на русском`}`);
    return;
  }
  const from = readArg('--from');
  const to = readArg('--to');
  const { shas, commits } = loadAndValidateCommits(from, to);
  if (command === 'validate') {
    console.log(`Проверено коммитов: ${commits.length}${shas.length ? ` (${shas[0].slice(0, 8)}…${shas.at(-1).slice(0, 8)})` : ''}`);
    return;
  }

  const target = cleanSha(to) || cleanSha(process.env.RELEASE_SHA) || cleanSha(git(['rev-parse', 'HEAD']));
  const source = readArg('--source', 'manual');
  if (!['web', 'desktop', 'manual'].includes(source)) fail(`Неизвестный source релиза: ${source}`);
  const createdAt = target ? git(['show', '-s', '--format=%cI', target]) : new Date().toISOString();
  const release = buildRelease(commits, {
    sha: target,
    source,
    version: readArg('--version') || undefined,
    attempt: readArg('--attempt') || `${target || 'manual'}:1`,
    createdAt,
  });
  release.commitCandidates = buildCommitCandidates(target, release, source);
  // workflow_dispatch redeploys an already known SHA. It must not create a second audience
  // snapshot from a shorter synthetic range; the original push remains authoritative.
  if (process.argv.includes('--no-announce')) release.announce = false;
  const output = readArg('--output');
  const json = `${JSON.stringify(release, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, json, 'utf8');
    console.log(`${release.publish ? 'Собран' : 'Пропущен'} патчноут: ${output} (${release.notes.length} пунктов; owner=${release.owner}; announce=${release.announce}; components=${release.requiredComponents.join(',') || 'none'})`);
  } else process.stdout.write(json);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try { main(); }
  catch (error) { console.error(`release-notes: ${error.message}`); process.exitCode = 1; }
}
