import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'engine.ts'), 'utf8');
const file = ts.createSourceFile('engine.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const engine = file.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'Engine');
assert.ok(engine && ts.isClassDeclaration(engine), 'Engine class must exist');

const methodText = (name) => {
  const member = engine.members.find((node) => (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node))
    && node.name?.getText(file) === name);
  assert.ok(member, `${name} must exist`);
  return member.getText(file);
};

const hubConnect = methodText('connect');
assert.doesNotMatch(hubConnect, /Track\.Source\.Microphone/,
  'server-wide hub handlers must not publish or subscribe microphone media');
assert.match(hubConnect, /RoomEvent\.DataReceived/,
  'hub must keep server-wide data events');

const mediaConnect = methodText('connectVoiceMediaRoom');
assert.ok(mediaConnect.indexOf('api.getVoiceMediaToken') < mediaConnect.indexOf('room.connect'),
  'media token must be obtained before connecting the exact channel room');
assert.ok(mediaConnect.indexOf('room.connect') < mediaConnect.indexOf('activateVoiceMediaRoom'),
  'join-only media participant must connect before exact-lease activation');
assert.match(methodText('activateVoiceMediaRoom'), /api\.activateVoiceMedia/,
  'media activation must go through the authenticated server endpoint');
assert.match(methodText('waitVoiceMediaPermissions'), /ParticipantPermissionsChanged/,
  'microphone must wait for server-applied publish and subscribe permissions');

assert.match(methodText('micPub'), /voiceMediaRoom/,
  'local microphone publication must be read only from media room');
assert.match(methodText('startMic'), /const room = this\.voiceMediaRoom/,
  'local microphone must publish only into media room');
assert.match(methodText('applyGate'), /voiceMediaActivated\.has\(media\)/,
  'uplink gate must remain closed until media activation is current');

const transfer = methodText('transferMicPublication');
assert.match(transfer, /const track = this\.micLocalTrack/,
  'channel switch must reuse the owned processed LocalAudioTrack');
assert.match(transfer, /unpublishTrack\(track, false\)/,
  'channel switch must unpublish without stopping the microphone track');
assert.match(transfer, /publishExistingMic\(newRoom/,
  'the same microphone track must be republished into the new channel room');
assert.doesNotMatch(transfer, /getUserMedia/,
  'channel switch must not reacquire the microphone');
const publishExisting = methodText('publishExistingMic');
assert.match(publishExisting, /const micOp = this\.micEpoch/,
  'microphone republish must capture the exact pipeline generation');
assert.match(publishExisting, /this\.micEpoch === micOp && this\.micLocalTrack === track/,
  'late republish completion must not overwrite a newer microphone pipeline');
assert.match(methodText('checkMicAlive'), /publication\?\.track !== this\.micLocalTrack/,
  'watchdog must recover when the room publication differs from the owned microphone track');
assert.match(methodText('checkMicAlive'), /const preparedOnly = !!this\.micActx[\s\S]*if \(!preparedOnly\) await this\.stopMic\(room\)/,
  'mobile recovery must consume a gesture-prepared context without closing it first');
assert.match(methodText('startMic'), /this\.micStartInFlight = op[\s\S]*finally[\s\S]*this\.micStartInFlight === op/,
  'microphone capture must expose an exact in-flight generation until commit or disposal');
assert.match(methodText('checkMicAlive'), /this\.micStartInFlight !== 0/,
  'watchdog must not cancel a live gesture-bound capture operation');
assert.match(methodText('stopMic'), /this\.micStartInFlight = 0/,
  'explicit microphone teardown must still cancel the in-flight generation');

const joinVoiceText = methodText('joinVoice');
assert.match(joinVoiceText, /setBroadcastRoom\?\.\(this\.voiceRoom\)/,
  'browser screen broadcast must remain anchored to the server-wide hub');
assert.doesNotMatch(mediaConnect, /liveKitT\.(?:attach|setBroadcastRoom)/,
  'media room must never own screen discovery or broadcasting');

assert.doesNotMatch(joinVoiceText, /if\s*\(\s*!started\s*\|\|[^)]*voiceIntentCurrent[^)]*\)\s*return/,
  'a superseded mic generation must not strand the otherwise-current voice join');
assert.ok(joinVoiceText.lastIndexOf('this.startConnPoll()') < joinVoiceText.lastIndexOf('this.voiceConnecting = false'),
  'join completion must arm the watchdog without letting its immediate poll replace a newer mic operation');
assert.match(joinVoiceText, /if\s*\(\s*!started\s*\)\s*this\.ensureVoiceAudioRunning\(\)/,
  'a current join with a superseded mic generation must finish without overwriting newer mic state');
assert.ok(joinVoiceText.indexOf('if (this.currentVc === channelId && !this.voiceConnecting) return;')
  < joinVoiceText.indexOf('this.voiceReconnecting = false'),
  'a no-op tap on the reconnecting current channel must preserve reconnect/PTT fencing');

const replacementAt = joinVoiceText.indexOf('this.prepareReplacementMicContext()');
const ticketAt = joinVoiceText.indexOf('const ticketPromise');
assert.ok(replacementAt >= 0 && replacementAt < ticketAt,
  'double-tap join must create the replacement microphone context before network work');
assert.match(joinVoiceText, /stopMic\(replacedMedia, replacementMicContext\)/,
  'pending join teardown must preserve the gesture-bound replacement context');
assert.match(joinVoiceText, /leaveVoice\(replacementMicContext\)/,
  'cross-server pending join teardown must preserve the gesture-bound replacement context');
assert.match(joinVoiceText, /const replacingVoiceJoin = this\.inVoice && this\.voiceConnecting/,
  'replacement context preparation must cover every pending join before room-specific teardown');
const replacementContext = methodText('prepareReplacementMicContext');
assert.match(replacementContext, /prepared = new AudioContext\(\)/,
  'double-tap join must create a fresh gesture-bound microphone context');
assert.match(replacementContext, /this\.spCtx = this\.spCtx \|\| new AudioContext\(\)/,
  'double-tap join must preserve the shared speaking analyser context');
const stopMic = methodText('stopMic');
assert.match(stopMic, /replacementContext: AudioContext \| null/,
  'microphone teardown must accept explicit replacement context ownership');
assert.match(stopMic, /this\.micActx = preservedContext/,
  'replacement context ownership must transfer before teardown awaits');
assert.match(stopMic, /ctx && ctx !== preservedContext/,
  'teardown must not close the replacement microphone context');
assert.match(stopMic, /localTrack && localTrack !== publishedTrack/,
  'teardown must stop an owned microphone track even if a late room publication differs');
assert.match(stopMic, /finally\s*\{[\s\S]*if \(localTrack\)[\s\S]*localTrack\.stop\(\)/,
  'teardown must stop its owned track even when disconnected-room unpublish rejects');
assert.match(methodText('leaveVoice'), /stopMic\(vmr, replacementMicContext\)/,
  'cross-server leave must carry replacement context ownership through microphone teardown');

const wireMedia = methodText('wireVoiceMediaRoom');
const mediaReconnected = wireMedia.slice(wireMedia.indexOf('.on(RoomEvent.Reconnected'));
assert.match(mediaReconnected, /this\.pttDown = false/,
  'media reconnect must always require a fresh PTT press');
const permissionsAt = wireMedia.indexOf('.on(RoomEvent.ParticipantPermissionsChanged');
assert.ok(permissionsAt >= 0, 'active media room must observe permission changes');
const permissionLoss = wireMedia.slice(permissionsAt);
assert.match(permissionLoss, /voiceMediaActivated\.delete\(room\)/,
  'permission loss must immediately revoke local media activation');
assert.match(permissionLoss, /\+\+this\.voiceLeaseVerifySeq/,
  'permission loss must invalidate every older lease verifier');
assert.ok(permissionLoss.indexOf('this.reconcileAllAudio()') < permissionLoss.indexOf('this.clearVoiceAudio()'),
  'permission loss must unsubscribe before discarding attached remote audio');
assert.match(permissionLoss, /verifyVoiceLeaseAfterReconnect\(hub, this\.voiceEpoch, verifySeq, room, deadline\)/,
  'permission loss must start bounded exact-room lease recovery');
assert.match(permissionLoss, /if \(!exactCurrentChannel\) return/,
  'permission loss during a switch must stay fail-closed without verifying the old room against the new channel');
const permissionRecovery = methodText('beginVoicePermissionRecovery');
assert.match(permissionRecovery, /window\.setTimeout/,
  'permission recovery must retain a deadline independent from verifier generations');
assert.match(permissionRecovery, /void this\.leaveVoice\(\)/,
  'permission recovery deadline must terminate a still-current revoked room');
const leaseVerifier = methodText('verifyVoiceLeaseAfterReconnect');
assert.match(leaseVerifier, /failClosedDeadline/,
  'permission recovery must have a finite fail-closed deadline');
assert.match(leaseVerifier, /const recovery = this\.voicePermissionRecovery/,
  'reconnect replacement verifiers must inherit an active permission-recovery deadline');
assert.match(leaseVerifier, /await this\.leaveVoice\(\)/,
  'expired or stale permission recovery must leave voice safely');

const switchVoice = methodText('switchVoice');
assert.match(switchVoice, /reconnectingRooms\.delete\(previousMediaRoom\)/,
  'successful switch must remove retired media room reconnect state');
assert.match(switchVoice, /voiceReconnecting = this\.reconnectingRooms\.has\(room\) \|\| this\.reconnectingRooms\.has\(nextMediaRoom\)/,
  'successful switch must derive reconnect state only from the new media room and active hub');
assert.match(switchVoice, /const previousPermissionDeadline = permissionRecovery\?\.room === previousMediaRoom/,
  'switch must retain the old room permission-recovery deadline until its new intent is confirmed');
assert.match(switchVoice, /beginVoicePermissionRecovery\(previousMediaRoom, epoch, recoveryDeadline \?\? Date\.now\(\) \+ 20_000\)/,
  'failed switch rollback must restore bounded permission recovery on the old media room');
assert.match(switchVoice, /verifyVoiceLeaseAfterReconnect\(room, epoch, recoveryVerifySeq, previousMediaRoom, recoveryDeadline\)/,
  'failed switch rollback must resume exact old-room lease verification');
assert.match(switchVoice, /const unfinishedClaim = this\.finishVoiceClaim\(epoch, null\)/,
  'failed switch must drain ownership events deferred while its ticket was pending');
assert.match(switchVoice, /this\.currentVc = previousChannel/,
  'failed switch must restore the known old channel before applying deferred ownership');
assert.match(switchVoice, /const lateRecovery = this\.voicePermissionRecovery/,
  'failed switch must observe permission loss that arrived after the switch began');
assert.match(switchVoice, /!this\.mediaPermissionsActive\(previousMediaRoom\) \|\| !this\.voiceMediaActivated\.has\(previousMediaRoom\)/,
  'failed switch must inspect actual old-room permissions instead of trusting its pre-switch snapshot');

const terminalMediaLoss = methodText('handleVoiceMediaDisconnected');
assert.doesNotMatch(terminalMediaLoss, /disconnectRoom\(this\.viewRoom\)|this\.disconnect\(\)/,
  'terminal media loss must not tear down the viewed hub or account engine');

console.log('voice media isolation: ok');
