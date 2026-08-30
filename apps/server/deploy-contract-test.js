'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const serverDockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');

test('health endpoint advertises the exact persistent voice compatibility marker', () => {
  assert.match(server, /const HEALTH_CAPABILITY_MARKER = 'ok persistent-v1 voice-media-v1';/u);
  assert.match(server, /app\.get\('\/healthz',[\s\S]*?send\(HEALTH_CAPABILITY_MARKER\)\);/u);
});

test('server-first readiness accepts only exact unauthenticated media-token 401 and capabilities', () => {
  const serverFirst = workflow.indexOf('docker compose up -d token');
  const webRelease = workflow.indexOf('\n            docker compose up -d\n', serverFirst);
  assert.ok(serverFirst >= 0 && webRelease > serverFirst);
  const gate = workflow.slice(serverFirst, webRelease);
  assert.match(gate, /health_capabilities[\s\S]*= "ok persistent-v1 voice-media-v1"/u);
  assert.match(gate, /voice_media_status" = "401"/u);
  // Kept as an explicit rollout regression guard for the historical Cannot POST response.
  assert.match(gate, /voice_media_status" != "404"/u);
  assert.doesNotMatch(gate, /voice_media_status" != "000"/u);
});

test('both immutable images carry and are checked against the release capability floor', () => {
  assert.equal((workflow.match(/org\.relayapp\.release-sequence=\$\{\{ steps\.release_meta\.outputs\.sequence \}\}/gu) || []).length, 2);
  assert.equal((workflow.match(/org\.relayapp\.capabilities=persistent-v1,voice-media-v1/gu) || []).length, 2);
  assert.match(workflow, /verify_release_image "\$\{\{ env\.IMAGE_SERVER \}\}:\$\{\{ github\.sha \}\}" server/u);
  assert.match(workflow, /verify_release_image "\$\{\{ env\.IMAGE_WEB \}\}:\$\{\{ github\.sha \}\}" web/u);
  assert.match(workflow, /\[ "\$image_sequence" = "\$candidate_seq" \]/u);
  assert.match(workflow, /\[ "\$image_capabilities" = "persistent-v1,voice-media-v1" \]/u);

  const imageCheck = workflow.indexOf('verify_release_image "${{ env.IMAGE_SERVER }}');
  const baselineCheck = workflow.indexOf('auth_baseline_file=', imageCheck);
  const serverStart = workflow.indexOf('docker compose up -d token', baselineCheck);
  assert.ok(imageCheck >= 0 && baselineCheck > imageCheck && serverStart > baselineCheck,
    'image capability/sequence and forward-only baseline checks must precede server replacement');
});

test('production server image contains every module required by the declared capability', () => {
  for (const file of ['authSessions.js', 'voiceMediaRevocations.js', 'voiceAuthRegistry.js']) {
    assert.match(serverDockerfile, new RegExp(`(?:^|\\s)${file.replace('.', '\\.')}(?=\\s|$)`, 'u'));
  }
  assert.match(workflow, /test -f \/app\/authSessions\.js && test -f \/app\/voiceAuthRegistry\.js/u);
});
