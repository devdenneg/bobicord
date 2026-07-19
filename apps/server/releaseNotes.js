const SYSTEM_USER_ID = 'system:release';
const SYSTEM_NAME = 'RelayApp';
const RELEASE_KIND = 'release';
const SHA_RE = /^[0-9a-f]{40}$/i;
const SOURCE_ORDER = ['web', 'desktop', 'manual'];
const SAFE_SOURCE = new Set(SOURCE_ORDER);
const NOTE_LIMIT = 30;
const NOTE_LENGTH = 200;
const CANDIDATE_LIMIT = 256;
const CANDIDATE_NOTE_LIMIT = 30;
const CANDIDATE_TEXT_LIMIT = 120000;

function installReleaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deploy_releases(
      sha TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '',
      required_components TEXT NOT NULL DEFAULT '[]',
      attempt TEXT NOT NULL DEFAULT '',
      input_notes TEXT NOT NULL DEFAULT '[]',
      candidate_commits TEXT NOT NULL DEFAULT '[]',
      superseded_by TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending',
      created INTEGER NOT NULL,
      finalized INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS deploy_release_targets(
      sha TEXT NOT NULL,
      server_id TEXT NOT NULL,
      audience INTEGER NOT NULL DEFAULT 0,
      message_id INTEGER,
      PRIMARY KEY(sha, server_id)
    );
    CREATE TABLE IF NOT EXISTS deploy_release_components(
      sha TEXT NOT NULL,
      source TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(sha, source)
    );
    CREATE TABLE IF NOT EXISTS deploy_release_commits(
      release_sha TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '[]',
      components TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(release_sha, commit_sha)
    );
    CREATE TABLE IF NOT EXISTS deploy_release_coverage(
      commit_sha TEXT PRIMARY KEY,
      release_sha TEXT NOT NULL,
      outcome TEXT NOT NULL,
      covered_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_release_targets_server ON deploy_release_targets(server_id, sha);
    CREATE INDEX IF NOT EXISTS idx_release_components_sha ON deploy_release_components(sha, completed);
    CREATE INDEX IF NOT EXISTS idx_release_commits_sha ON deploy_release_commits(release_sha, position);
  `);
  // The first local iterations of the feature did not have a component barrier. Keep startup
  // forward-compatible with such a DB instead of requiring a manual migration on the VPS.
  const columns = new Set(db.prepare('PRAGMA table_info(deploy_releases)').all().map((row) => row.name));
  if (!columns.has('required_components')) {
    db.exec("ALTER TABLE deploy_releases ADD COLUMN required_components TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has('attempt')) {
    db.exec("ALTER TABLE deploy_releases ADD COLUMN attempt TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('input_notes')) {
    db.exec("ALTER TABLE deploy_releases ADD COLUMN input_notes TEXT NOT NULL DEFAULT '[]'");
    db.exec('UPDATE deploy_releases SET input_notes=notes');
  }
  if (!columns.has('candidate_commits')) {
    db.exec("ALTER TABLE deploy_releases ADD COLUMN candidate_commits TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has('superseded_by')) {
    db.exec("ALTER TABLE deploy_releases ADD COLUMN superseded_by TEXT NOT NULL DEFAULT ''");
  }
}

function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function cleanSource(value) {
  const source = cleanText(value, 16).toLowerCase();
  if (!SAFE_SOURCE.has(source)) throw new Error('invalid release source');
  return source;
}

function normalizeRequiredComponents(raw, source) {
  const values = raw == null ? [source] : raw;
  if (!Array.isArray(values) || !values.length) throw new Error('release components are empty');
  const unique = new Set();
  for (const value of values) unique.add(cleanSource(value));
  if (!unique.has(source)) throw new Error('release source is not a required component');
  if (unique.has('manual') && unique.size !== 1) throw new Error('manual release cannot be mixed with deploy components');
  return SOURCE_ORDER.filter((value) => unique.has(value));
}

function normalizeAttempt(raw, sha) {
  const attempt = cleanText(raw, 96).toLowerCase() || `${sha}:1`;
  const match = attempt.match(new RegExp(`^${sha}:([1-9][0-9]{0,8})$`, 'u'));
  if (!match) throw new Error('invalid release attempt');
  return { attempt, attemptNumber: Number(match[1]) };
}

function cleanCandidateNotes(raw) {
  const notes = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return notes;
  for (const value of raw.slice(0, CANDIDATE_NOTE_LIMIT)) {
    const note = cleanText(value, NOTE_LENGTH);
    const key = note.toLocaleLowerCase('ru-RU');
    if (note.length < 8 || !/[А-Яа-яЁё]/u.test(note) || seen.has(key)) continue;
    seen.add(key);
    notes.push(note);
  }
  return notes;
}

function cleanCandidateComponents(raw) {
  if (!Array.isArray(raw)) throw new Error('invalid candidate components');
  const unique = new Set(raw.map((value) => cleanSource(value)));
  if (unique.has('manual') && unique.size !== 1) throw new Error('manual candidate cannot be mixed');
  return SOURCE_ORDER.filter((value) => unique.has(value));
}

function sanitizeCommitCandidates(raw, sha, currentNotes, requiredComponents) {
  const values = Array.isArray(raw) ? raw : [];
  if (values.length > CANDIDATE_LIMIT) throw new Error('too many release candidates');
  const candidates = [];
  const seen = new Set();
  let totalText = 0;
  for (const value of values) {
    if (!value || typeof value !== 'object') throw new Error('invalid release candidate');
    const commitSha = cleanText(value.sha, 40).toLowerCase();
    if (!SHA_RE.test(commitSha) || seen.has(commitSha)) throw new Error('invalid release candidate sha');
    const notes = cleanCandidateNotes(value.notes);
    const components = cleanCandidateComponents(value.components || []);
    totalText += notes.reduce((sum, note) => sum + note.length, 0);
    if (totalText > CANDIDATE_TEXT_LIMIT) throw new Error('release candidates are too large');
    seen.add(commitSha);
    candidates.push({ sha: commitSha, notes, components });
  }

  let head = candidates.find((candidate) => candidate.sha === sha);
  if (!head) {
    if (candidates.length >= CANDIDATE_LIMIT) throw new Error('release head is outside candidate window');
    head = { sha, notes: [...currentNotes], components: [...requiredComponents] };
    candidates.push(head);
  }
  const represented = new Set(candidates.flatMap((candidate) => candidate.notes)
    .map((note) => note.toLocaleLowerCase('ru-RU')));
  if (currentNotes.some((note) => !represented.has(note.toLocaleLowerCase('ru-RU')))) {
    head.notes = [...currentNotes];
    head.components = [...requiredComponents];
  }
  return candidates;
}

function sanitizeReleasePayload(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('invalid release payload');
  const sha = cleanText(raw.sha, 40).toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error('invalid release sha');
  const source = cleanSource(raw.source);
  const requiredComponents = normalizeRequiredComponents(raw.requiredComponents, source);
  const { attempt, attemptNumber } = normalizeAttempt(raw.attempt, sha);
  const publish = raw.publish !== false && raw.announce !== false;
  const notes = [];
  if (Array.isArray(raw.notes)) {
    for (const value of raw.notes.slice(0, NOTE_LIMIT)) {
      const note = cleanText(value, NOTE_LENGTH);
      if (note.length >= 8 && /[А-Яа-яЁё]/u.test(note)) notes.push(note);
    }
  }
  if (publish && !notes.length) throw new Error('release notes are empty');
  const commitCandidates = sanitizeCommitCandidates(raw.commitCandidates, sha, publish ? notes : [], requiredComponents);
  const version = cleanText(raw.version, 32);
  return {
    sha,
    source,
    title: 'Обновление RelayApp',
    notes: publish ? notes : [],
    version: /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version) ? version : '',
    publish: publish && notes.length > 0,
    requiredComponents,
    commitCandidates,
    attempt,
    attemptNumber,
  };
}

function activeChatSnapshot(db, notifyConns) {
  const usersByServer = new Map();
  const membership = db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND server_id=?');
  for (const [userId, sockets] of notifyConns) {
    for (const ws of sockets) {
      if (!ws || ws.readyState !== 1 || !ws._activeServerId) continue;
      const serverId = String(ws._activeServerId);
      if (!membership.get(userId, serverId)) continue;
      let users = usersByServer.get(serverId);
      if (!users) { users = new Set(); usersByServer.set(serverId, users); }
      users.add(userId);
    }
  }
  return [...usersByServer.entries()]
    .map(([serverId, users]) => ({ serverId, audience: users.size }))
    .sort((a, b) => a.serverId.localeCompare(b.serverId));
}

function releaseRow(db, sha) {
  return db.prepare(`SELECT sha,source,title,notes,version,required_components,attempt,input_notes,
    candidate_commits,superseded_by,state,created,finalized FROM deploy_releases WHERE sha=?`).get(sha);
}

function attemptForRow(row) {
  return normalizeAttempt(row && row.attempt, row.sha);
}

function requiredComponentsForRow(row) {
  const stored = safeJson(row && row.required_components, []);
  const candidates = Array.isArray(stored) && stored.length ? stored : [row && row.source];
  const unique = new Set(candidates.map((value) => cleanText(value, 16).toLowerCase()).filter((value) => SAFE_SOURCE.has(value)));
  return SOURCE_ORDER.filter((value) => unique.has(value));
}

function releaseTargets(db, sha) {
  return db.prepare('SELECT server_id serverId,audience,message_id messageId FROM deploy_release_targets WHERE sha=? ORDER BY server_id').all(sha);
}

function ensureReleaseComponents(db, sha, requiredComponents) {
  const insert = db.prepare('INSERT OR IGNORE INTO deploy_release_components(sha,source) VALUES(?,?)');
  for (const source of requiredComponents) insert.run(sha, source);
}

function componentProgress(db, sha, requiredComponents) {
  const rows = db.prepare('SELECT source,completed FROM deploy_release_components WHERE sha=?').all(sha);
  const completedSet = new Set(rows.filter((row) => row.completed).map((row) => row.source));
  return {
    completedComponents: requiredComponents.filter((source) => completedSet.has(source)),
    pendingComponents: requiredComponents.filter((source) => !completedSet.has(source)),
  };
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCandidates(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

function releaseCommitRows(db, sha, fallbackRow = null) {
  const rows = db.prepare(`SELECT commit_sha sha,position,notes,components
    FROM deploy_release_commits WHERE release_sha=? ORDER BY position,commit_sha`).all(sha)
    .map((row) => ({
      sha: row.sha,
      position: Number(row.position) || 0,
      notes: safeJson(row.notes, []),
      components: safeJson(row.components, []),
    }));
  if (rows.length || !fallbackRow) return rows;
  return [{
    sha,
    position: 0,
    notes: safeJson(fallbackRow.notes, []),
    components: requiredComponentsForRow(fallbackRow),
  }];
}

function aggregateNotes(candidates) {
  const all = [];
  const seen = new Set();
  for (const candidate of candidates) {
    for (const note of candidate.notes || []) {
      const clean = cleanText(note, NOTE_LENGTH);
      const key = clean.toLocaleLowerCase('ru-RU');
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      all.push(clean);
    }
  }
  if (all.length <= NOTE_LIMIT) return all;
  const hidden = all.length - (NOTE_LIMIT - 1);
  return [...all.slice(0, NOTE_LIMIT - 1), `И ещё ${hidden} улучшений в этом обновлении.`];
}

function saveReleaseCommits(db, releaseSha, candidates) {
  const insert = db.prepare(`INSERT INTO deploy_release_commits(
    release_sha,commit_sha,position,notes,components
  ) VALUES(?,?,?,?,?)`);
  candidates.forEach((candidate, position) => insert.run(
    releaseSha, candidate.sha, position, JSON.stringify(candidate.notes || []), JSON.stringify(candidate.components || []),
  ));
}

function coverReleaseCommits(db, releaseSha, candidates, outcome, now) {
  const insert = db.prepare(`INSERT OR IGNORE INTO deploy_release_coverage(
    commit_sha,release_sha,outcome,covered_at
  ) VALUES(?,?,?,?)`);
  for (const candidate of candidates) insert.run(candidate.sha, releaseSha, outcome, now);
}

function validatePreparedPayload(db, row, payload) {
  const requiredComponents = requiredComponentsForRow(row);
  if (!requiredComponents.includes(payload.source)) throw new Error('release source mismatch');
  if (!sameStringArray(requiredComponents, payload.requiredComponents)) throw new Error('release components mismatch');
  const storedNotes = safeJson(row.input_notes || row.notes, []);
  if (!sameStringArray(storedNotes, payload.notes)) throw new Error('release notes mismatch');
  const storedCandidates = safeJson(row.candidate_commits, []);
  if (storedCandidates.length && !sameCandidates(storedCandidates, payload.commitCandidates)) {
    throw new Error('release candidates mismatch');
  }
  if (!!storedNotes.length !== payload.publish) throw new Error('release publish mode mismatch');
  if (row.version && payload.version && row.version !== payload.version) throw new Error('release version mismatch');
  if (!row.version && payload.version) {
    db.prepare("UPDATE deploy_releases SET version=? WHERE sha=? AND version=''").run(payload.version, payload.sha);
  }
  ensureReleaseComponents(db, payload.sha, requiredComponents);
  return requiredComponents;
}

function prepareRelease(db, notifyConns, rawPayload, now = Date.now()) {
  const payload = sanitizeReleasePayload(rawPayload);
  // Snapshot computation stays outside the write lock. The authoritative existence check is
  // repeated inside BEGIN IMMEDIATE, so two workflows may race without duplicate rows/errors.
  const quickRow = releaseRow(db, payload.sha);
  const quickAttempt = quickRow ? attemptForRow(quickRow) : null;
  const mayReplaceSnapshot = !quickRow || (quickRow.state === 'pending' && payload.attemptNumber > quickAttempt.attemptNumber);
  const candidateTargets = mayReplaceSnapshot ? (payload.publish ? activeChatSnapshot(db, notifyConns) : []) : null;
  const prepare = db.transaction(() => {
    const existing = releaseRow(db, payload.sha);
    if (existing) {
      const requiredComponents = validatePreparedPayload(db, existing, payload);
      let progress = componentProgress(db, payload.sha, requiredComponents);
      const storedAttempt = attemptForRow(existing);
      let effectiveAttempt = storedAttempt.attempt;
      let snapshotReplaced = false;
      // A failed deploy never reaches finalize, so no component is completed. A newer CI attempt
      // may then take a fresh audience snapshot. Once any component succeeded, the original
      // snapshot is locked until the whole multi-component update finishes.
      if (existing.state === 'pending' && payload.attemptNumber > storedAttempt.attemptNumber
        && progress.completedComponents.length === 0) {
        db.prepare('DELETE FROM deploy_release_targets WHERE sha=?').run(payload.sha);
        const addTarget = db.prepare('INSERT INTO deploy_release_targets(sha,server_id,audience) VALUES(?,?,?)');
        for (const target of candidateTargets || []) addTarget.run(payload.sha, target.serverId, target.audience);
        db.prepare('UPDATE deploy_releases SET attempt=?,created=? WHERE sha=? AND state=\'pending\'')
          .run(payload.attempt, now, payload.sha);
        db.prepare('UPDATE deploy_release_components SET completed=0,completed_at=0 WHERE sha=?').run(payload.sha);
        effectiveAttempt = payload.attempt;
        snapshotReplaced = true;
        progress = componentProgress(db, payload.sha, requiredComponents);
      }
      const targets = releaseTargets(db, payload.sha).map(({ serverId, audience }) => ({ serverId, audience }));
      return {
        created: false, sha: payload.sha, source: payload.source, state: existing.state,
        supersededBy: existing.superseded_by || '',
        attempt: effectiveAttempt, requestedAttempt: payload.attempt, snapshotReplaced,
        requiredComponents, ...progress, targets,
        audience: targets.reduce((sum, row) => sum + row.audience, 0),
      };
    }

    const headCoverage = db.prepare('SELECT release_sha releaseSha FROM deploy_release_coverage WHERE commit_sha=?')
      .get(payload.sha);
    if (headCoverage) {
      db.prepare(`INSERT INTO deploy_releases(
        sha,source,title,notes,version,required_components,attempt,input_notes,candidate_commits,superseded_by,state,created,finalized
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        payload.sha, payload.source, payload.title, JSON.stringify(payload.notes), payload.version,
        JSON.stringify(payload.requiredComponents), payload.attempt, JSON.stringify(payload.notes),
        JSON.stringify(payload.commitCandidates), headCoverage.releaseSha, 'superseded', now, now,
      );
      ensureReleaseComponents(db, payload.sha, payload.requiredComponents);
      return {
        created: true, sha: payload.sha, source: payload.source, state: 'superseded',
        supersededBy: headCoverage.releaseSha, attempt: payload.attempt, requestedAttempt: payload.attempt,
        snapshotReplaced: false, requiredComponents: payload.requiredComponents,
        completedComponents: [], pendingComponents: payload.requiredComponents, targets: [], audience: 0,
      };
    }

    const lineageOrder = new Map(payload.commitCandidates.map((candidate, index) => [candidate.sha, index]));
    const selected = new Map();
    const isCovered = db.prepare('SELECT 1 FROM deploy_release_coverage WHERE commit_sha=?');
    const addCandidate = (candidate, fallbackPosition = -1) => {
      if (!candidate || selected.has(candidate.sha) || isCovered.get(candidate.sha)) return;
      selected.set(candidate.sha, {
        sha: candidate.sha,
        notes: Array.isArray(candidate.notes) ? candidate.notes : [],
        components: Array.isArray(candidate.components) ? candidate.components : [],
        order: lineageOrder.has(candidate.sha) ? lineageOrder.get(candidate.sha) : fallbackPosition,
      });
    };

    // A newer first-parent descendant may finish the still-missing components of an older
    // release. Move its unannounced commits forward and make every late finalize a no-op.
    const pendingRows = db.prepare("SELECT * FROM deploy_releases WHERE state='pending' AND sha<>? ORDER BY created,sha")
      .all(payload.sha);
    let carriedPosition = -pendingRows.length * (CANDIDATE_LIMIT + 1);
    for (const older of pendingRows) {
      if (!lineageOrder.has(older.sha)) continue;
      const olderRequired = requiredComponentsForRow(older);
      const olderProgress = componentProgress(db, older.sha, olderRequired);
      if (!olderProgress.pendingComponents.every((component) => payload.requiredComponents.includes(component))) continue;
      for (const candidate of releaseCommitRows(db, older.sha, older)) addCandidate(candidate, carriedPosition++);
      db.prepare("UPDATE deploy_releases SET state='superseded',superseded_by=?,finalized=? WHERE sha=? AND state='pending'")
        .run(payload.sha, now, older.sha);
    }

    for (const candidate of payload.commitCandidates) {
      if (candidate.components.every((component) => payload.requiredComponents.includes(component))) addCandidate(candidate);
    }
    const selectedCandidates = [...selected.values()]
      .sort((left, right) => left.order - right.order || left.sha.localeCompare(right.sha));
    const cumulativeNotes = aggregateNotes(selectedCandidates);
    const targets = candidateTargets || (payload.publish ? activeChatSnapshot(db, notifyConns) : []);
    db.prepare(`INSERT INTO deploy_releases(
      sha,source,title,notes,version,required_components,attempt,input_notes,candidate_commits,superseded_by,state,created
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      payload.sha, payload.source, payload.title, JSON.stringify(cumulativeNotes), payload.version,
      JSON.stringify(payload.requiredComponents), payload.attempt, JSON.stringify(payload.notes),
      JSON.stringify(payload.commitCandidates), '', 'pending', now,
    );
    saveReleaseCommits(db, payload.sha, selectedCandidates);
    ensureReleaseComponents(db, payload.sha, payload.requiredComponents);
    const addTarget = db.prepare('INSERT INTO deploy_release_targets(sha,server_id,audience) VALUES(?,?,?)');
    for (const target of targets) addTarget.run(payload.sha, target.serverId, target.audience);
    return {
      created: true, sha: payload.sha, source: payload.source, state: 'pending',
      supersededBy: '',
      attempt: payload.attempt, requestedAttempt: payload.attempt, snapshotReplaced: false,
      requiredComponents: payload.requiredComponents, completedComponents: [], pendingComponents: payload.requiredComponents,
      targets, audience: targets.reduce((sum, row) => sum + row.audience, 0),
    };
  });
  return prepare.immediate();
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeStoredRelease(row, publishedAt) {
  if (!row || !SHA_RE.test(String(row.sha || ''))) return null;
  const notes = safeJson(row.notes, []);
  if (!Array.isArray(notes) || !notes.length) return null;
  return {
    sha: row.sha,
    title: row.title || 'Обновление RelayApp',
    notes: notes.map((note) => cleanText(note, NOTE_LENGTH)).filter(Boolean).slice(0, NOTE_LIMIT),
    ...(row.version ? { version: row.version } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function formatReleaseText(notes) {
  return (Array.isArray(notes) ? notes : []).map((note) => `• ${cleanText(note, NOTE_LENGTH)}`).join('\n').slice(0, 1000);
}

function finalizeRelease(db, rawSha, rawSource, rawAttempt, now = Date.now()) {
  const sha = cleanText(rawSha, 40).toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error('invalid release sha');
  const source = cleanSource(rawSource);
  const requestedAttemptInfo = normalizeAttempt(rawAttempt, sha);
  const requestedAttempt = requestedAttemptInfo.attempt;
  const finalize = db.transaction(() => {
    const current = releaseRow(db, sha);
    if (!current) throw new Error('release was not prepared');
    const storedAttemptInfo = attemptForRow(current);
    const attempt = storedAttemptInfo.attempt;
    const requiredComponents = requiredComponentsForRow(current);
    if (!requiredComponents.includes(source)) throw new Error('release source mismatch');
    ensureReleaseComponents(db, sha, requiredComponents);
    const progressBefore = componentProgress(db, sha, requiredComponents);
    if (requestedAttemptInfo.attemptNumber < storedAttemptInfo.attemptNumber) throw new Error('stale release attempt');
    if (current.state === 'pending' && requestedAttemptInfo.attemptNumber > storedAttemptInfo.attemptNumber
      && progressBefore.completedComponents.length === 0) throw new Error('release attempt was not prepared');

    if (current.state === 'published' || current.state === 'skipped') {
      const progress = progressBefore;
      const deliveries = current.state === 'published' ? releaseTargets(db, sha).filter((row) => row.messageId != null) : [];
      const release = current.state === 'published' ? normalizeStoredRelease(current, current.finalized) : null;
      return {
        changed: false, componentChanged: false, sha, source, state: current.state,
        attempt, requestedAttempt,
        requiredComponents, ...progress, release, text: release ? formatReleaseText(release.notes) : '', deliveries,
      };
    }
    if (current.state === 'superseded') {
      return {
        changed: false, componentChanged: false, sha, source, state: 'superseded',
        supersededBy: current.superseded_by || '', attempt, requestedAttempt,
        requiredComponents, ...progressBefore, release: null, text: '', deliveries: [],
      };
    }
    if (current.state !== 'pending') throw new Error('invalid release state');

    const marked = db.prepare(`UPDATE deploy_release_components
      SET completed=1,completed_at=? WHERE sha=? AND source=? AND completed=0`).run(now, sha, source);
    const progress = componentProgress(db, sha, requiredComponents);
    if (progress.pendingComponents.length) {
      return {
        changed: !!marked.changes, componentChanged: !!marked.changes, sha, source, state: 'pending',
        attempt, requestedAttempt,
        requiredComponents, ...progress, release: null, text: '', deliveries: [],
      };
    }

    const coverageLookup = db.prepare('SELECT release_sha releaseSha FROM deploy_release_coverage WHERE commit_sha=?');
    const storedCandidates = releaseCommitRows(db, sha, current);
    const uncovered = [];
    let supersededBy = '';
    for (const candidate of storedCandidates) {
      const coverage = coverageLookup.get(candidate.sha);
      if (coverage) supersededBy ||= coverage.releaseSha;
      else uncovered.push(candidate);
    }
    if (!uncovered.length) {
      const superseded = db.prepare("UPDATE deploy_releases SET state='superseded',superseded_by=?,finalized=? WHERE sha=? AND state='pending'")
        .run(supersededBy, now, sha);
      if (superseded.changes !== 1) throw new Error('release state changed while superseding');
      return {
        changed: true, componentChanged: !!marked.changes, sha, source, state: 'superseded',
        supersededBy, attempt, requestedAttempt, requiredComponents, ...progress,
        release: null, text: '', deliveries: [],
      };
    }

    const cumulativeNotes = aggregateNotes(uncovered);
    db.prepare('UPDATE deploy_releases SET notes=? WHERE sha=? AND state=\'pending\'')
      .run(JSON.stringify(cumulativeNotes), sha);
    const effectiveCurrent = { ...current, notes: JSON.stringify(cumulativeNotes) };
    const targets = releaseTargets(db, sha);
    const release = normalizeStoredRelease(effectiveCurrent, now);
    if (!targets.length || !release) {
      const skipped = db.prepare("UPDATE deploy_releases SET state='skipped',finalized=? WHERE sha=? AND state='pending'").run(now, sha);
      if (skipped.changes !== 1) throw new Error('release state changed while skipping');
      coverReleaseCommits(db, sha, uncovered, 'skipped', now);
      return {
        changed: true, componentChanged: !!marked.changes, sha, source, state: 'skipped',
        attempt, requestedAttempt,
        requiredComponents, ...progress, release: null, text: '', deliveries: [],
      };
    }

    const insertMessage = db.prepare(`INSERT OR IGNORE INTO messages(
      server_id,user_id,display_name,avatar_color,text,emotes,image,attachments,reply_to,created,client_key,kind,meta
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const findMessage = db.prepare('SELECT id FROM messages WHERE server_id=? AND user_id=? AND client_key=?');
    const saveTarget = db.prepare('UPDATE deploy_release_targets SET message_id=? WHERE sha=? AND server_id=?');
    const text = formatReleaseText(release.notes);
    const meta = JSON.stringify(release);
    const clientKey = `release:${sha}`;
    for (const target of targets) {
      insertMessage.run(target.serverId, SYSTEM_USER_ID, SYSTEM_NAME, 4, text, '{}', '', '[]', '', now, clientKey, RELEASE_KIND, meta);
      const message = findMessage.get(target.serverId, SYSTEM_USER_ID, clientKey);
      if (!message) throw new Error(`release message missing for ${target.serverId}`);
      target.messageId = Number(message.id);
      saveTarget.run(target.messageId, sha, target.serverId);
    }
    const published = db.prepare("UPDATE deploy_releases SET state='published',finalized=? WHERE sha=? AND state='pending'").run(now, sha);
    if (published.changes !== 1) throw new Error('release state changed while publishing');
    coverReleaseCommits(db, sha, uncovered, 'published', now);
    return {
      changed: true, componentChanged: !!marked.changes, sha, source, state: 'published',
      attempt, requestedAttempt,
      requiredComponents, ...progress, release, text, deliveries: targets,
    };
  });
  return finalize.immediate();
}

function parseReleaseMeta(kind, rawMeta) {
  if (kind !== RELEASE_KIND || !rawMeta) return undefined;
  const parsed = safeJson(rawMeta, null);
  if (!parsed || !SHA_RE.test(String(parsed.sha || '')) || !Array.isArray(parsed.notes)) return undefined;
  const notes = parsed.notes.map((note) => cleanText(note, NOTE_LENGTH)).filter((note) => note.length >= 8).slice(0, NOTE_LIMIT);
  if (!notes.length) return undefined;
  const publishedAt = Number(parsed.publishedAt) || undefined;
  const version = cleanText(parsed.version, 32);
  return {
    sha: String(parsed.sha).toLowerCase(),
    title: cleanText(parsed.title, 80) || 'Обновление RelayApp',
    notes,
    ...(version ? { version } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

module.exports = {
  RELEASE_KIND,
  SYSTEM_USER_ID,
  activeChatSnapshot,
  finalizeRelease,
  formatReleaseText,
  installReleaseSchema,
  parseReleaseMeta,
  prepareRelease,
  sanitizeReleasePayload,
};
