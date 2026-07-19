const fs = require('fs');
const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change';
const action = String(process.argv[2] || '');
const file = String(process.argv[3] || '');

if (!['prepare', 'finalize'].includes(action) || !file) {
  console.error('usage: node publish-release.js <prepare|finalize> <release.json>');
  process.exit(2);
}

async function main() {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (payload.announce === false) {
    console.log(JSON.stringify({ ok: true, state: 'not-owner', owner: payload.owner || 'none', sha: payload.sha || '' }));
    return;
  }
  const sha = String(payload.sha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error('invalid release sha');
  const source = String(payload.source || '').toLowerCase();
  if (!['web', 'desktop', 'manual'].includes(source)) throw new Error('invalid release source');
  const attempt = String(payload.attempt || `${sha}:1`).toLowerCase();
  if (!new RegExp(`^${sha}:[1-9][0-9]{0,8}$`, 'u').test(attempt)) throw new Error('invalid release attempt');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(`release:${action}:${sha}:${source}:${attempt}`).digest('hex');
  const body = action === 'prepare' ? { ...payload, sha, source, attempt } : { sha, source, attempt };
  const response = await fetch(`http://127.0.0.1:3000/internal/releases/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-release-signature': signature },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`release ${action} failed (${response.status}): ${text.slice(0, 500)}`);
  let result; try { result = JSON.parse(text); } catch { result = { ok: true, state: 'unknown' }; }
  console.log(JSON.stringify({
    ok: !!result.ok, action, sha: sha.slice(0, 8), source,
    state: result.state || 'unknown', changed: !!result.changed,
    servers: Number(result.servers != null ? result.servers : (result.targets || []).length) || 0,
    pendingComponents: result.pendingComponents || [],
  }));
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
