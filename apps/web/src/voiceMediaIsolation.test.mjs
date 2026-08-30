import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const normalizeSource = (value) => value.replace(/\r\n?/gu, '\n');
const readSource = (...segments) => normalizeSource(readFileSync(join(here, ...segments), 'utf8'));
assert.equal(normalizeSource('windows\r\nlegacy-mac\r'), 'windows\nlegacy-mac\n',
  'source-contract checks normalize platform line endings');
const source = readSource('engine.ts');
const storeSource = readSource('store.ts');
const voiceDockSource = readSource('components', 'VoiceDock.tsx');
const deploySource = readSource('..', '..', '..', '.github', 'workflows', 'deploy.yml');
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
assert.match(hubConnect, /new Room\(\{[\s\S]*disconnectOnPageLeave: false/,
  'iOS PWA pagehide/freeze must not make LiveKit terminally disconnect the server hub');
assert.doesNotMatch(hubConnect, /Track\.Source\.Microphone/,
  'server-wide hub handlers must not publish or subscribe microphone media');
assert.match(hubConnect, /RoomEvent\.DataReceived/,
  'hub must keep server-wide data events');

const mediaConnect = methodText('connectVoiceMediaRoom');
assert.match(methodText('createVoiceMediaRoom'), /disconnectOnPageLeave: false/,
  'iOS PWA pagehide/freeze must preserve the exact channel room for foreground mic recovery');
assert.ok(mediaConnect.indexOf('api.getVoiceMediaToken') < mediaConnect.indexOf('room.connect'),
  'media token must be obtained before connecting the exact channel room');
assert.ok(mediaConnect.indexOf('room.connect') < mediaConnect.indexOf('activateVoiceMediaRoom'),
  'join-only media participant must connect before exact-lease activation');
assert.match(mediaConnect, /withVoiceDeadline[\s\S]*api\.getVoiceMediaToken/,
  'media token fetch must be bounded by the voice operation deadline');
assert.match(mediaConnect, /withVoiceDeadline[\s\S]*room\.connect/,
  'exact media room connect must have a finite deadline');
assert.match(mediaConnect, /isApiError\(error\)[\s\S]*error\.status === 404[\s\S]*'server-updating'/,
  'a rolling old API is distinguished from a device/channel media failure without a legacy fallback');
const serverFirstAt = deploySource.indexOf('docker compose up -d token');
const mediaProbeAt = deploySource.indexOf('/api/voice/media-token', serverFirstAt);
const fullReleaseAt = deploySource.indexOf('\n            docker compose up -d\n', mediaProbeAt);
assert.ok(serverFirstAt >= 0 && mediaProbeAt > serverFirstAt && fullReleaseAt > mediaProbeAt,
  'deployment must make the compatible voice API healthy before exposing the matching web shell');
assert.match(deploySource.slice(mediaProbeAt, fullReleaseAt), /voice_media_status[\s\S]*!= "404"/,
  'the server-first gate verifies route capability rather than healthz alone');
const mediaActivation = methodText('activateVoiceMediaRoom');
assert.match(mediaActivation, /api\.activateVoiceMedia/,
  'media activation must go through the authenticated server endpoint');
assert.match(mediaActivation, /withVoiceDeadline[\s\S]*api\.activateVoiceMedia/,
  'each media activation request must have a finite deadline');
assert.match(mediaActivation, /const deadline = operationDeadline/,
  'durable revocation retry must retain the transaction absolute deadline');
assert.doesNotMatch(mediaActivation, /Date\.now\(\) \+ 10_000/,
  'a shorter activation ceiling must not expire before the server due-drain window');
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
assert.match(methodText('checkMicAlive'), /microphoneTransportHealth\([\s\S]*publication\?\.track === this\.micLocalTrack[\s\S]*publication\?\.isUpstreamPaused === true/,
  'watchdog must validate the exact publication, processed destination and paused sender');
assert.match(methodText('checkMicAlive'), /const preparedOnly = !!this\.micActx && reusableMicrophoneAudioContextState\(this\.micActx\.state\)[\s\S]*if \(!preparedOnly\)[\s\S]*stopMic\(room, recoveryContext\)/,
  'mobile recovery must preserve a resumable prepared AudioContext instead of closing it before reacquisition');
assert.match(methodText('checkMicAlive'), /const recoveryContext = reusableMicrophoneAudioContextState\(this\.micActx\?\.state\) \? this\.micActx : null/,
  'an iOS-interrupted microphone context must be retired instead of republishing a silent destination');
assert.match(methodText('checkMicAlive'), /micContextNeedsReplacement[\s\S]*!reusableMicrophoneAudioContextState\(this\.micActx\.state\)[\s\S]*const ended = !this\.micActx \|\| micContextNeedsReplacement/,
  'an interrupted graph must recover even while its raw and published tracks still look live');
assert.match(methodText('startMic'), /micStartOwnership\.begin\(op\)[\s\S]*finally[\s\S]*micStartOwnership\.finish\(op\)/,
  'microphone capture must keep exact single-flight ownership until commit or disposal');
assert.match(methodText('checkMicAlive'), /micStartOwnership\.active/,
  'watchdog must not overlap a live gesture-bound capture operation');
assert.match(methodText('stopMic'), /micStartOwnership\.invalidate\(\)/,
  'explicit microphone teardown must invalidate the in-flight generation');

const joinVoiceText = methodText('joinVoice');
const queueVoiceJoin = methodText('queueVoiceJoin');
const flushPendingVoiceJoin = methodText('flushPendingVoiceJoin');
assert.match(joinVoiceText, /!targetRoom \|\| !this\.readyRooms\.has\(targetRoom\)[\s\S]*queueVoiceJoin\(channelId, targetServer\)[\s\S]*return/,
  'a first channel tap must queue instead of binding voice to a replaceable pending view room');
assert.match(joinVoiceText, /this\.reconnectingRooms\.has\(targetRoom\)[\s\S]*queueVoiceJoin\(channelId, targetServer\)/,
  'a channel tap during transport recovery must remain queued until the view room is stable');
assert.ok(joinVoiceText.indexOf('queueVoiceJoin(channelId, targetServer)') < joinVoiceText.indexOf('this.currentVc = channelId'),
  'queued view connection cannot expose optimistic membership or start the channel timer');
assert.match(queueVoiceJoin, /if \(!this\.inVoice\) this\.prepareVoiceAudio\(\)/,
  'queued first join must preserve the tap-bound mobile AudioContext');
assert.match(queueVoiceJoin, /existing\?\.serverId === serverId && existing\.channelId === channelId[\s\S]*this\.prepareVoiceAudio\(\)[\s\S]*existing\.initialMicContext = this\.micActx/,
  'a repeated identical queued tap revives or replaces its exact initial microphone context');
assert.match(queueVoiceJoin, /existing\.replacementMicContext = resumeGestureAudioContext\([\s\S]*existing\.replacementMicContext/,
  'a repeated cross-server queued tap revives or replaces its gesture-owned context');
assert.ok(queueVoiceJoin.indexOf('existing?.serverId === serverId') < queueVoiceJoin.indexOf('if (existing) this.cancelPendingVoiceJoin()'),
  'an identical queued tap must retain its original intent and absolute timeout');
const prepareVoiceAudio = methodText('prepareVoiceAudio');
const resumeSharedVoiceAudio = methodText('resumeSharedVoiceAudio');
assert.match(resumeSharedVoiceAudio, /this\.spCtx = resumeSharedGestureAudioContext\(this\.spCtx, \(\) => new AudioContext\(\)\)/,
  'an interrupted shared analyser context must retain its exact graph while resuming under the tap');
assert.doesNotMatch(resumeSharedVoiceAudio, /resumeGestureAudioContext\(/,
  'shared analyser recovery must not use the strict replaceable microphone-context policy');
assert.match(resumeSharedVoiceAudio, /const output = this\.getOutputContext\(\)[\s\S]*requestExactAudioContextResume\(output, true\)/,
  'the first channel tap creates and resumes the shared playback context under user activation');
assert.match(prepareVoiceAudio, /this\.micActx = resumeGestureAudioContext\(this\.micActx, \(\) => new AudioContext\(\)\)/,
  'the replaceable microphone processing context must retain strict interrupted-state recovery');
assert.match(prepareVoiceAudio, /this\.resumeSharedVoiceAudio\(\)/,
  'the first channel tap synchronously resumes every shared playback context');
assert.match(methodText('prepareReplacementMicContext'), /this\.resumeSharedVoiceAudio\(\)/,
  'a replacement channel tap also resumes an existing suspended playback context');
assert.match(hubConnect, /const outputCtx = this\.getOutputContext\(\)[\s\S]*webAudioMix: outputCtx \? \{ audioContext: outputCtx \} : true/,
  'the later hub Room reuses the exact gesture-prepared playback context');
assert.match(methodText('createVoiceMediaRoom'), /const outputCtx = this\.getOutputContext\(\)[\s\S]*webAudioMix: outputCtx \? \{ audioContext: outputCtx \} : true/,
  'the exact channel Room reuses the same gesture-prepared playback context');
const resumeRemoteAudioPlayback = methodText('resumeRemoteAudioPlayback');
const startRoomAudio = methodText('startRoomAudio');
const beginOutputContextRecovery = methodText('beginOutputContextRecovery');
const finishOutputContextRecovery = methodText('finishOutputContextRecovery');
assert.match(resumeRemoteAudioPlayback, /outputMixerNeedsRecovery\(\)[\s\S]*beginOutputContextRecovery\(explicitGesture, gestureToken\)/,
  'a closed or split exact mixer is rebound before any ordinary/gesture playback retry');
assert.match(resumeRemoteAudioPlayback, /requestExactAudioContextResume\(this\.outputCtx, explicitGesture\)/,
  'ordinary and gesture playback recovery share exact output-context ownership');
assert.match(resumeRemoteAudioPlayback, /this\.startRoomAudio\(room as Room, explicitGesture, gestureToken\)/,
  'the exact room receives the same explicit-gesture recovery lane as its media elements');
assert.match(startRoomAudio, /this\.remoteAudioStarts\.acquire\([\s\S]*current\.startAudio\(\)[\s\S]*explicitGesture[\s\S]*gestureToken[\s\S]*return attempt\.outcome/,
  'a user gesture invokes room.startAudio synchronously without waiting behind a stuck ordinary call');
assert.match(beginOutputContextRecovery, /rebindExactWebAudioMixContexts\(rooms, replacement\)/,
  'all current LiveKit Rooms atomically receive the exact fresh output context');
assert.doesNotMatch(beginOutputContextRecovery, /getVoiceMediaToken|activateVoiceMedia|claimVoiceLease/,
  'output recovery must not mint another media lease or expose a second voice join');
assert.match(beginOutputContextRecovery, /remoteAudioStarts\.forget\(room\)[\s\S]*triggerOutputContextRecovery\(recovery, explicitGesture, gestureToken\)/,
  'closed-context room attempts are fenced before synchronous recovery under the current gesture');
assert.match(methodText('triggerOutputContextRecovery'), /ordinaryStartedRooms\.has\(room\)[\s\S]*ordinaryStartedRooms\.add\(room\)/,
  'the recovery watchdog makes at most one ordinary startAudio attempt per exact Room');
assert.match(methodText('triggerOutputContextRecovery'), /explicitGesture \|\| !recovery\.ordinaryContextStarted[\s\S]*ordinaryContextStarted = true/,
  'the recovery watchdog also makes at most one ordinary native context resume');
assert.match(finishOutputContextRecovery, /document\.hidden[\s\S]*remainingMs[\s\S]*context\.state === 'running'[\s\S]*allBound[\s\S]*allStarted/,
  'hidden time cannot launch/consume recovery, and visible recovery requires exact context plus room playback confirmation');
assert.match(finishOutputContextRecovery, /failOutputContextRecovery\(recovery\.voiceEpoch, recovery\.voiceRoom, recovery\.voiceChannel\)/,
  'a bounded recovery failure exits only the exact still-current voice intent');
assert.match(resumeRemoteAudioPlayback, /remoteAudioPlays\.request\([\s\S]*explicitGesture[\s\S]*gestureToken/,
  'overlapping unlock consumers share the same physical gesture token for exact media elements');
assert.match(methodText('disconnectRoom'), /this\.remoteAudioStarts\.forget\(room\)/,
  'disconnecting an exact room fences any late startAudio settlement');
for (const method of [methodText('ensureRemoteAudioPlayback'), methodText('ensureVoiceAudioRunning')]) {
  assert.match(method, /new AudioUnlockGestureDeduper\(\)[\s\S]*if \(!gestures\.accept\(event\)\) return/,
    'every document-level audio unlock dedupes compatibility events from one physical activation');
  assert.match(method, /currentAudioUnlockGestureToken\(\)/,
    'all exact-target coordinators receive the shared token for that physical activation');
  assert.match(method, /removeEventListener\('click', unlock, true\)[\s\S]*addEventListener\('click', unlock, true\)/,
    'the click compatibility fallback has symmetric teardown');
}
assert.match(queueVoiceJoin, /VOICE_JOIN_TIMEOUT_MS/,
  'a queued first join must expire instead of waiting forever for background room retries');
assert.match(flushPendingVoiceJoin, /this\.viewRoom !== room \|\| !this\.readyRooms\.has\(room\)/,
  'only the exact current successful view room may consume a queued channel intent');
assert.match(flushPendingVoiceJoin, /this\.reconnectingRooms\.has\(room\)/,
  'a reconnecting room cannot consume a queued channel intent');
assert.match(flushPendingVoiceJoin, /joinVoice\(pending\.channelId, pending\.replacementMicContext\)/,
  'cross-server queued join carries its gesture-prepared replacement context to the ready room');
assert.equal((flushPendingVoiceJoin.match(/this\.joinVoice\(pending\.channelId, pending\.replacementMicContext\)/g) || []).length, 1,
  'one ready-room transition must consume a queued intent exactly once');
assert.ok(hubConnect.indexOf('this.readyRooms.add(r)') < hubConnect.lastIndexOf('this.flushPendingVoiceJoin(r, serverId)'),
  'view connect flushes channel intent only after LiveKit success is recorded');
const reconnectHandlerAt = hubConnect.indexOf('.on(RoomEvent.Reconnected');
const initialConnectCompletionAt = hubConnect.indexOf('this.readyRooms.add(r)');
assert.ok(reconnectHandlerAt >= 0 && hubConnect.slice(reconnectHandlerAt, initialConnectCompletionAt).includes('this.flushPendingVoiceJoin(r, serverId)'),
  'an exact successful Reconnected event consumes the tap queued during a mobile radio gap');
assert.match(methodText('detachView'), /cancelPendingVoiceJoin/,
  'leaving or replacing the viewed server cancels its queued voice intent');
const ensureRemoteVoicePlayback = methodText('ensureRemoteVoicePlayback');
assert.ok(ensureRemoteVoicePlayback.indexOf('this.applyVolumeToParticipant(p!)')
  < ensureRemoteVoicePlayback.indexOf('remoteTrack.attach()'),
  'saved desktop voice gain is seeded before attach creates an audible GainNode');
assert.equal((ensureRemoteVoicePlayback.match(/ensureRemoteAudioPlayback\(\)/g) || []).length, 1,
  'one participant reconciliation batch performs one shared autoplay recovery pass');
assert.doesNotMatch(methodText('configureVoiceAudio'), /ensureRemoteAudioPlayback/,
  'per-participant configuration cannot multiply native context/room recovery calls');
const onSub = methodText('onSub');
assert.ok(onSub.indexOf('this.applyScreenAudioGain(u, p)') < onSub.indexOf('track.attach()'),
  'saved stream gain is seeded before first screen-audio attach');
assert.ok(onSub.lastIndexOf('this.applyVolumeToParticipant(p)') < onSub.lastIndexOf('track.attach()'),
  'saved voice gain is seeded before first microphone-audio attach');
assert.match(methodText('detachView'), /pendingVoiceJoin\?\.serverId === nextServerId[\s\S]*reconnectingRooms\.has\(this\.viewRoom\)/,
  'the store may replace a dead/reconnecting room for the same server without dropping its explicit channel tap');
assert.match(storeSource, /engine\?\.detachView\(id\)/,
  'a terminal same-server retry tells Engine which queued intent may be preserved');

// Deterministic lifecycle model for the two mobile recovery outcomes. The tap is never exposed as
// joined while the transport is reconnecting; either the same Room recovers and consumes it, or a
// terminal loss carries it into the exact same-server replacement Room.
{
  const state = { server: 's1', ready: true, reconnecting: true, pending: null, joined: null };
  const tap = (channel) => {
    if (!state.ready || state.reconnecting) { state.pending = { server: state.server, channel }; return; }
    state.joined = channel;
  };
  const flush = () => {
    if (!state.pending || !state.ready || state.reconnecting || state.pending.server !== state.server) return;
    state.joined = state.pending.channel; state.pending = null;
  };
  tap('voice-a');
  assert.equal(state.joined, null, 'Reconnecting → tap cannot bind voice to the unstable Room');
  state.reconnecting = false; flush();
  assert.equal(state.joined, 'voice-a', 'Reconnecting → tap → Reconnected consumes the exact intent once');

  state.joined = null; state.reconnecting = true; tap('voice-b');
  state.ready = false; state.reconnecting = false; // terminal Disconnected
  const retryServer = 's1';
  if (state.pending?.server !== retryServer) state.pending = null; // detachView(nextServerId)
  assert.equal(state.pending?.channel, 'voice-b', 'same-server replacement preserves the explicit tap');
  state.ready = true; flush();
  assert.equal(state.joined, 'voice-b', 'fresh connected Room consumes the preserved intent');
  assert.equal(state.pending, null);
}

const pollPing = methodText('pollPing');
assert.match(source, /voiceStatsInFlight: \{ room: Room; track: object; voiceEpoch: number; generation: number \} \| null = null/,
  'WebRTC stats has one actual browser request owner across timer ticks and voice sessions');
assert.ok(pollPing.indexOf('this.ensureRemoteVoicePlayback()') < pollPing.indexOf('this.voiceStatsInFlight) return'),
  'a stuck cosmetic stats request cannot stop the microphone and playback watchdog ticks');
assert.match(pollPing, /const room = this\.voiceMediaRoom[\s\S]*const track = room\?\.localParticipant[\s\S]*this\.voiceStatsInFlight\) return/,
  'stats polling captures the exact media room and track and is strictly single-flight');
assert.match(pollPing, /owner = \{ room, track, voiceEpoch: this\.voiceEpoch, generation: this\.voiceStatsGeneration \}/,
  'a stats request captures both voice and polling generations before awaiting the browser');
assert.match(pollPing, /await Promise\.resolve\(\)\.then\(\(\) => \(track as any\)\.getRTCStatsReport\(\)\)/,
  'even a synchronous browser stats failure is owned and released through the exact finally');
assert.match(pollPing, /this\.voiceStatsGeneration !== owner\.generation[\s\S]*this\.voiceEpoch !== owner\.voiceEpoch[\s\S]*this\.voiceMediaRoom !== room[\s\S]*currentTrack !== track/,
  'late stats from an old channel cannot overwrite the current connection indicator');
assert.match(pollPing, /const lp = room\.localParticipant/,
  'quality is derived from the captured room after the current-intent fence');
assert.match(pollPing, /finally[\s\S]*this\.voiceStatsInFlight === owner[\s\S]*this\.voiceStatsInFlight = null/,
  'only the exact settled native stats operation may release single-flight ownership');
assert.match(methodText('stopConnPoll'), /\+\+this\.voiceStatsGeneration/,
  'leaving voice invalidates any late stats continuation without spawning another native request');
assert.match(joinVoiceText, /setBroadcastRoom\?\.\(this\.voiceRoom\)/,
  'browser screen broadcast must remain anchored to the server-wide hub');
assert.doesNotMatch(mediaConnect, /liveKitT\.(?:attach|setBroadcastRoom)/,
  'media room must never own screen discovery or broadcasting');

assert.match(joinVoiceText, /const joinDeadline = Date\.now\(\) \+ VOICE_JOIN_TIMEOUT_MS/,
  'the complete first voice join must have one absolute deadline');
assert.match(joinVoiceText, /connectVoiceMediaRoom\(targetRoom, epoch, targetServer, channelId, joinDeadline\)/,
  'the exact media connection must inherit the first-join deadline');
assert.match(joinVoiceText, /commitVoiceAttributes\(targetRoom, epoch, channelId, joinDeadline\)/,
  'authoritative voice attributes must inherit the first-join deadline');
assert.ok(joinVoiceText.lastIndexOf('this.startConnPoll()') < joinVoiceText.lastIndexOf('this.voiceConnecting = false'),
  'confirmed join completion must arm mobile recovery before dropping the connection spinner');
assert.ok(joinVoiceText.indexOf('commitVoiceAttributes(targetRoom, epoch, channelId, joinDeadline)')
  < joinVoiceText.indexOf('this.voicePresenceConfirmed = true'),
  'the local channel timer must remain hidden until media-backed attributes commit');
assert.ok(joinVoiceText.indexOf('this.voicePresenceConfirmed = true')
  < joinVoiceText.lastIndexOf('this.voiceConnecting = false'),
  'the spinner may clear only at the confirmed media and attributes boundary');
assert.match(joinVoiceText, /void this\.finishInitialMic\(epoch, targetRoom, mediaRoom, channelId\)/,
  'microphone bootstrap must run independently after the channel is connected');
assert.doesNotMatch(joinVoiceText, /await this\.startMicWithDefaultFallback/,
  'a denied or stuck microphone must never hold the channel connection spinner');
assert.match(joinVoiceText, /voiceMediaFailureText\(/,
  'join maps the exact media failure before presenting it to the user');
assert.match(methodText('voiceMediaFailureText'), /Сервер ещё обновляется — голос станет доступен/,
  'an old API reports an actionable rollout mismatch instead of blaming the device or channel');
const switchContextOutput = methodText('switchContextOutput');
assert.match(switchContextOutput, /Promise\.allSettled\([\s\S]*queueContextOutput\(requested\)[\s\S]*treeSwitch/,
  'main and tree playback routes must both settle before an output device is accepted');
assert.match(switchContextOutput, /treeOutcome === 'failed'[\s\S]*treeOutcome === 'timed-out'/,
  'a failed or timed-out tree route must fall back instead of leaving split output');
const finishInitialMic = methodText('finishInitialMic');
assert.match(finishInitialMic, /await this\.startMicWithDefaultFallback/,
  'listen-only join must still attempt bounded microphone bootstrap');
assert.match(finishInitialMic, /this\.noMic = true[\s\S]*Микрофон недоступен/,
  'failed microphone bootstrap must keep an honest listen-only state');
assert.ok(joinVoiceText.indexOf('if (this.currentVc === channelId && !this.voiceConnecting) return;')
  < joinVoiceText.indexOf('this.voiceReconnecting = false'),
  'a no-op tap on the reconnecting current channel must preserve reconnect/PTT fencing');

const replacementAt = joinVoiceText.indexOf('this.prepareReplacementMicContext()');
const ticketAt = joinVoiceText.indexOf('const ticketPromise');
assert.ok(replacementAt >= 0 && replacementAt < ticketAt,
  'double-tap join must create the replacement microphone context before network work');
assert.match(joinVoiceText, /stopMic\(replacedMedia, replacementMicContext\)/,
  'pending join teardown must preserve the gesture-bound replacement context');
assert.match(joinVoiceText, /leaveVoice\(replacementMicContext, true\)/,
  'cross-server pending join teardown must preserve the gesture-bound replacement context');
assert.match(joinVoiceText, /const replacingVoiceJoin = this\.inVoice && this\.voiceConnecting/,
  'replacement context preparation must cover every pending join before room-specific teardown');
const replacementContext = methodText('prepareReplacementMicContext');
assert.match(replacementContext, /resumeGestureAudioContext<AudioContext>\(null, \(\) => new AudioContext\(\)\)/,
  'double-tap join must create a fresh gesture-bound microphone context');
assert.match(replacementContext, /this\.resumeSharedVoiceAudio\(\)/,
  'double-tap join must preserve the shared speaking analyser context');
const stopMic = methodText('stopMic');
assert.match(stopMic, /replacementContext: AudioContext \| null/,
  'microphone teardown must accept explicit replacement context ownership');
assert.match(stopMic, /const preservedContext = reusableMicrophoneAudioContextState\(replacementContext\?\.state\)[\s\S]*\? replacementContext[\s\S]*: null/,
  'no teardown caller may preserve an interrupted or unknown microphone context');
assert.match(stopMic, /this\.micActx = preservedContext/,
  'replacement context ownership must transfer before teardown awaits');
assert.match(stopMic, /const contextsToClose = new Set<AudioContext>\(\)[\s\S]*ctx && ctx !== preservedContext[\s\S]*contextsToClose\.add\(ctx\)/,
  'teardown must retire the old context unless it is the exact accepted replacement');
assert.match(stopMic, /replacementContext && replacementContext !== preservedContext[\s\S]*contextsToClose\.add\(replacementContext\)/,
  'a distinct interrupted or unknown replacement context must also be retired');
assert.match(stopMic, /for \(const context of contextsToClose\)[\s\S]*forgetExactAudioContextResume\(context\)[\s\S]*waits\.push\(context\.close\(\)\)/,
  'rejected exact contexts must be forgotten, closed once, and included in bounded cleanup');
assert.match(stopMic, /localTrack && localTrack !== publishedTrack/,
  'teardown must stop an owned microphone track even if a late room publication differs');
assert.match(stopMic, /finally\s*\{[\s\S]*if \(localTrack\)[\s\S]*localTrack\.stop\(\)/,
  'teardown must stop its owned track even when disconnected-room unpublish rejects');
assert.match(stopMic, /withVoiceTimeout\(Promise\.allSettled\(waits\), VOICE_CLEANUP_TIMEOUT_MS/,
  'SDK unpublish or AudioContext close must not hold teardown forever');
assert.match(methodText('leaveVoice'), /stopMic\(vmr, replacementMicContext\)/,
  'cross-server leave must carry replacement context ownership through microphone teardown');

assert.match(methodText('build'), /this\.voicePresenceConfirmed \? this\.myVcAt : null/,
  'optimistic local membership must not expose channelActiveSince before confirmed presence');
assert.match(methodText('setVoiceAttributes'), /withVoiceTimeout\(write, VOICE_ATTRIBUTE_TIMEOUT_MS/,
  'a stuck SDK attribute write must not poison every later voice intent');
const commitVoiceAttributes = methodText('commitVoiceAttributes');
assert.match(commitVoiceAttributes, /voiceWriteCommittedForCurrentIntent/,
  'attribute completion must recheck the exact voice intent after its deferred SDK write');
assert.match(commitVoiceAttributes, /if \(!intentCurrent\(\)\) return false/,
  'a superseded attribute writer must fail before any caller can finalize presence');
assert.match(joinVoiceText, /commitVoiceAttributes\(targetRoom, epoch, channelId, joinDeadline\)[\s\S]*voiceIntentCurrent\(epoch, targetRoom, channelId\)[\s\S]*voicePresenceConfirmed = true/,
  'join must recheck its exact intent after attribute commit and before starting the local timer');
const boundedMic = methodText('startMicBeforeDeadline');
assert.match(boundedMic, /withVoiceDeadline\(attempt, deadline, 'microphone start'\)/,
  'getUserMedia, RNNoise and publish must share a finite microphone deadline');
assert.match(boundedMic, /isVoiceOperationTimeout\(error\)[\s\S]*\+\+this\.micEpoch/,
  'a timed-out microphone generation must be invalidated before it can publish late');
assert.match(methodText('watchLateVoiceClaim'), /releaseVoiceLease\(session, lease\.epoch\)/,
  'a lease claim response arriving after rollback must be released by exact epoch');

const onVisible = methodText('onVisible');
const startConnPoll = methodText('startConnPoll');
const stopConnPoll = methodText('stopConnPoll');
assert.match(startConnPoll, /window\.addEventListener\('focus', this\.onVoiceFocus\)/,
  'iOS PWA focus must provide a foreground recovery fallback when pageshow is skipped');
assert.match(stopConnPoll, /window\.removeEventListener\('focus', this\.onVoiceFocus\)/,
  'voice teardown must remove the exact focus recovery listener');
assert.match(methodText('onVoiceFocus'), /onVisible\(true\)/,
  'focus fallback must explicitly request damaged-transport validation');
assert.match(methodText('onVoicePageHide'), /markVoiceHidden/,
  'pagehide must record iOS PWA backgrounding even when visibilitychange is skipped');
assert.doesNotMatch(methodText('onVoicePageHide'), /disconnect|leaveVoice/,
  'ordinary iOS backgrounding must not be treated as explicit voice leave');
assert.match(onVisible, /returningFromBackground[\s\S]*foregroundMicNeedsImmediateRecovery/,
  'foreground must detect an iOS-muted or ended owned capture immediately');
assert.match(onVisible, /focusFallback[\s\S]*microphoneTransportHealth[\s\S]*micForegroundRecoveryPending = true/,
  'focus without pagehide must arm recovery only after concrete transport damage');
assert.match(onVisible, /checkMicAlive\(false\)/,
  'foreground must invoke fenced microphone recovery without waiting for a throttled timer');
assert.match(methodText('checkMicAlive'), /immediateForegroundRecovery[\s\S]*!immediateForegroundRecovery/,
  'foreground recovery must bypass the ordinary muted-track grace period');
const micRecovery = methodText('checkMicAlive');
assert.ok(micRecovery.indexOf('if (this.voiceCaptureUnavailable())') >= 0
  && micRecovery.indexOf('if (this.voiceCaptureUnavailable())') < micRecovery.indexOf('this.stopMic(')
  && micRecovery.indexOf('if (this.voiceCaptureUnavailable())') < micRecovery.indexOf('this.startMicWithDefaultFallback'),
  'hidden lifecycle must fence teardown and getUserMedia before recovery starts');
const startMic = methodText('startMic');
assert.ok(startMic.indexOf('if (this.voiceCaptureUnavailable())') >= 0
  && startMic.indexOf('if (this.voiceCaptureUnavailable())') < startMic.indexOf('navigator.mediaDevices.getUserMedia'),
  'every voice getUserMedia call must have a same-turn visibility/pagehide guard');
assert.ok(startMic.lastIndexOf('hiddenAfterAwait') > startMic.indexOf('navigator.mediaDevices.getUserMedia'),
  'voice capture must recheck visibility after deferred gUM/RNNoise/mute/publish work');
assert.match(startMic, /hiddenAfterAwait\(true, dispose\)[\s\S]*dispose\(true\)/,
  'a page hidden after publish must unpublish and dispose its exact uncommitted pipeline');
assert.match(methodText('voiceCaptureUnavailable'), /document\.hidden \|\| this\.voiceHiddenAt > 0/,
  'pagehide/BFCache must fence capture even before document.hidden changes');
assert.match(startMic, /micHadCapture = true;[\s\S]*micBootstrapWanted = false;[\s\S]*micForegroundRecoveryPending = false;/,
  'a successful foreground capture must consume recovery intent instead of causing a second watchdog capture');
assert.match(micRecovery, /automaticMicRecoveryAllowed/,
  'watchdog must distinguish prior capture from stable initial listen-only denial');
assert.match(micRecovery, /if \(!this\.micHadCapture\) \{[\s\S]*this\.micBootstrapWanted = false/,
  'an initial denied bootstrap must disarm periodic permission retries');

const wireMedia = methodText('wireVoiceMediaRoom');
assert.doesNotMatch(wireMedia, /RoomEvent\.TrackMuted[\s\S]{0,300}playSound\('mute'\)/,
  'an iOS transport interruption must not impersonate a manual mute sound');
assert.doesNotMatch(wireMedia, /RoomEvent\.TrackUnmuted[\s\S]{0,300}playSound\('unmute'\)/,
  'an automatic transport resume must not impersonate a manual unmute sound');
assert.match(methodText('toggleMic'), /manualMute = !this\.manualMute[\s\S]*playSound\(this\.manualMute \? 'mute' : 'unmute'\)/,
  'microphone sounds belong to the explicit user toggle');
assert.doesNotMatch(methodText('build'), /mp\.isMuted/,
  'remote manual mute badges must not be derived from iOS transport mute');
assert.match(methodText('build'), /attributes\?\.mic === '0' \|\| deaf/,
  'durable hub intent remains authoritative for remote mute badges');
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
assert.match(leaseVerifier, /Date\.now\(\) \+ VOICE_RECONNECT_VERIFY_TIMEOUT_MS/,
  'ordinary reconnect and permission recovery must share a finite fail-closed deadline');
assert.match(leaseVerifier, /const recovery = this\.voicePermissionRecovery/,
  'reconnect replacement verifiers must inherit an active permission-recovery deadline');
assert.match(leaseVerifier, /const reconnectRecovery = this\.voiceReconnectRecovery/,
  'replacement reconnect verifiers must inherit the first transport disruption deadline');
assert.match(leaseVerifier, /withVoiceDeadline\([\s\S]*api\.getVoiceLease\(\)[\s\S]*voice reconnect lease snapshot/,
  'each reconnect lease snapshot must be individually bounded');
assert.match(leaseVerifier, /activateVoiceMediaRoom\(activeMedia, room, voiceEpoch, serverId, channelId, deadline\)/,
  'media reactivation must inherit the common reconnect deadline');
assert.match(leaseVerifier, /commitVoiceAttributes\(room, voiceEpoch, channelId, deadline\)/,
  'attribute re-commit must inherit the common reconnect deadline');
assert.match(leaseVerifier, /!this\.voiceMediaActivated\.has\(activeMedia\) \|\| !this\.mediaPermissionsActive\(activeMedia\)/,
  'a stale activation marker cannot finalize media whose SDK permissions are missing');
assert.match(leaseVerifier, /await this\.leaveVoice\(\)/,
  'expired or stale permission recovery must leave voice safely');
assert.match(leaseVerifier, /withVoiceDeadline\([\s\S]*publishExistingMic[\s\S]*voice reconnect microphone publish/,
  'reconnect SDK microphone publication must have a finite per-attempt deadline');
assert.match(leaseVerifier, /isVoiceOperationTimeout\(error\)[\s\S]*await this\.leaveVoice\(\)/,
  'a timed-out reconnect publication must retire the exact intent instead of remaining verifying forever');

const switchVoice = methodText('switchVoice');
assert.match(switchVoice, /voiceMediaFailureText\(epoch, 'Не удалось подключить новый голосовой канал'/,
  'channel switching reports the same exact rollout mismatch');
assert.ok(switchVoice.indexOf('this.voiceConnecting = true') >= 0
  && switchVoice.indexOf('this.voiceConnecting = true') < switchVoice.indexOf('const ticketEvent = await ticketPromise'),
  'a channel switch must expose and fence its pending state before network work');
assert.match(switchVoice, /const disruptionAtStart = this\.voiceTransportDisruptionSeq/,
  'a switch must capture the transport disruption generation it owns');
assert.match(switchVoice, /verifyVoiceTransactionBoundary\([\s\S]*nextMediaRoom[\s\S]*switchDeadline/,
  'a switch must verify exact current media after any reconnect before clearing its spinner');
assert.ok(switchVoice.lastIndexOf('this.voiceConnecting = false') > switchVoice.lastIndexOf('verifyVoiceTransactionBoundary'),
  'only the current verified switch may clear its connection fence');
assert.match(switchVoice, /replacementMicContext[\s\S]*prepareReplacementMicContext\(\)[\s\S]*micStartOwnership\.invalidate\(\)[\s\S]*this\.micActx = replacementMicContext/,
  'a channel switch during permission bootstrap must prepare current-intent audio ownership under the new tap');
assert.match(switchVoice, /micStartOwnership\.active[\s\S]*\+\+this\.micEpoch[\s\S]*micStartOwnership\.invalidate\(\)/,
  'channel switch must invalidate a pending old-channel permission or publish operation');
assert.match(switchVoice, /micBootstrapWanted[\s\S]*finishInitialMic\(epoch, room, nextMediaRoom, channelId\)/,
  'the current switched channel must inherit an unfinished initial microphone bootstrap');
assert.match(switchVoice, /commitVoiceAttributes\(room, epoch, channelId, switchDeadline\)[\s\S]*voiceIntentCurrent\(epoch, room, channelId\)[\s\S]*voicePresenceConfirmed = true/,
  'switch must recheck its exact intent after attribute commit and before starting the timer');
assert.match(switchVoice, /reconnectingRooms\.delete\(previousMediaRoom\)/,
  'successful switch must remove retired media room reconnect state');
assert.match(switchVoice, /voiceReconnecting = this\.reconnectingRooms\.has\(room\) \|\| this\.reconnectingRooms\.has\(nextMediaRoom\)/,
  'successful switch must derive reconnect state only from the new media room and active hub');
assert.match(switchVoice, /const previousPermissionDeadline = permissionRecovery\?\.room === previousMediaRoom/,
  'switch must retain the old room permission-recovery deadline until its new intent is confirmed');
assert.match(switchVoice, /beginVoicePermissionRecovery\(previousMediaRoom, epoch, recoveryDeadline \?\? Date\.now\(\) \+ 20_000\)/,
  'failed switch rollback must restore bounded permission recovery on the old media room');
assert.match(switchVoice, /verifyVoiceTransactionBoundary\([\s\S]*previousMediaRoom[\s\S]*recoveryDeadline/,
  'failed switch rollback must await exact old-room lease verification');
assert.match(switchVoice, /const unfinishedClaim = this\.finishVoiceClaim\(epoch, null\)/,
  'failed switch must drain ownership events deferred while its ticket was pending');
assert.match(switchVoice, /this\.currentVc = previousChannel/,
  'failed switch must restore the known old channel before applying deferred ownership');
assert.match(switchVoice, /const lateRecovery = this\.voicePermissionRecovery/,
  'failed switch must observe permission loss that arrived after the switch began');
assert.match(switchVoice, /!this\.mediaPermissionsActive\(previousMediaRoom\) \|\| !this\.voiceMediaActivated\.has\(previousMediaRoom\)/,
  'failed switch must inspect actual old-room permissions instead of trusting its pre-switch snapshot');

const toggleMic = methodText('toggleMic');
assert.ok(toggleMic.indexOf('micStartOwnership.active') >= 0
  && toggleMic.indexOf('micStartOwnership.active') < toggleMic.indexOf('startMicWithDefaultFallback'),
  'a second mic tap must be rejected before it can open a concurrent permission prompt');

const reconnectRecovery = methodText('beginVoiceReconnectRecovery');
assert.match(reconnectRecovery, /existing\.hub === hub && existing\.voiceEpoch === voiceEpoch[\s\S]*return existing\.deadline/,
  'reconnect flapping must reuse the first absolute deadline for the exact voice intent');
assert.match(reconnectRecovery, /window\.setTimeout[\s\S]*void this\.leaveVoice\(\)/,
  'an independently armed reconnect deadline must terminate a continuously flapping verifier');
const transactionBoundary = methodText('verifyVoiceTransactionBoundary');
assert.match(transactionBoundary, /voiceMediaActivated\.has\(media\) && this\.mediaPermissionsActive\(media\)/,
  'transaction completion requires exact active media permissions');
assert.match(transactionBoundary, /verifyVoiceLeaseAfterReconnect\(hub, voiceEpoch, verifySeq, media, deadline\)/,
  'join/switch owns one bounded verifier instead of starting an event-handler competitor');

assert.match(wireMedia, /room === this\.pendingVoiceMediaRoom/,
  'pending join/switch media must participate in reconnect and permission fencing');
assert.match(wireMedia, /if \(!this\.voiceConnecting && this\.voiceClaimPending === 0/,
  'media reconnect handlers must not start a verifier while join/switch owns the transaction');
assert.match(wireMedia, /const rollbackBaseline = room === this\.voiceMediaRoom/,
  'the confirmed old room remains fail-closed if it reconnects during a pending switch rollback');
assert.match(permissionRecovery, /this\.pendingVoiceMediaRoom === room/,
  'a pending-room permission deadline must terminate its exact transaction');

const micFence = methodText('fenceMicForCaptureRecovery');
assert.match(micFence, /retainAvailability = retainMicAvailabilityDuringRecovery\(this\.micHadCapture, this\.noMic\)/,
  'every non-terminal capture recovery keeps a previously working microphone logically available');
assert.match(micFence, /if \(!retainAvailability\) this\.noMic = true[\s\S]*this\.pttDown = false[\s\S]*setVoiceAttributes[\s\S]*emit/,
  'only an actually unavailable microphone may publish listen-only state during recovery');
assert.match(micRecovery, /retainMicAvailabilityDuringRecovery\(this\.micHadCapture, this\.noMic\)[\s\S]*fenceMicForCaptureRecovery\(hub, retainAvailability\)/,
  'a previously working microphone keeps its durable talk intent while transport is rebuilt');
assert.match(micRecovery, /catch \{[\s\S]*this\.noMic = true[\s\S]*setVoiceAttributes/,
  'a confirmed recovery failure still exposes microphone unavailability to peers');
assert.match(methodText('applyGate'), /micRecoveryOwner !== 0/,
  'the uplink gate stays closed while recovery no longer borrows the manual mute state');
assert.match(methodText('watchMicTracks'), /new Set\(\[rawTrack, publishedTrack\]\)[\s\S]*track\.addEventListener\('mute'/,
  'raw and processed microphone tracks must share one lifecycle watchdog');
assert.match(voiceDockSource, /suppressPttClick\.current = latchRejectedPttHold\(ptt, recovering, muted\)/,
  'a rejected recovery-time PTT hold must remain latched until its later synthetic click');
assert.match(voiceDockSource, /if \(ptt && recovering && !muted\)[\s\S]*event\.preventDefault\(\)[\s\S]*return/,
  'a recovery-time PTT click must not become a persistent mute toggle');
assert.match(methodText('toggleMic'), /if \(this\.inVoice && !this\.deafened\) playSound/,
  'manual mic preference changes while deafened must not announce a false audible unmute');
const pttPress = methodText('pttPress');
assert.match(pttPress, /micStartOwnership\.active[\s\S]*micRecoveryOwner !== 0[\s\S]*!this\.hasHealthyCurrentMicTransport\(\)/,
  'PTT must reject while capture is recovering or lacks the exact current publication');
assert.match(methodText('hasExactCurrentMicPublication'), /publication\?\.track === track/,
  'stale-owner guards must recognize the newer publication by exact ownership');
assert.doesNotMatch(methodText('hasExactCurrentMicPublication'), /microphoneTransportHealth|readyState|muted|upstreamPaused/,
  'stale-owner guards must recognize a newer exact publication through any temporary iOS transport damage');
assert.match(methodText('hasHealthyCurrentMicTransport'), /!health\.ended && !health\.muted && !health\.upstreamPaused/,
  'PTT requires both exact identity and a healthy active sender');
const foregroundSupersede = methodText('supersedeHiddenMicOperations');
assert.match(foregroundSupersede, /micStartOwnership\.owner === this\.hiddenMicStartOwner[\s\S]*\+\+this\.micEpoch[\s\S]*invalidate/,
  'foreground must supersede the exact gUM owner observed at hide time');
assert.match(foregroundSupersede, /micRecoveryOwner === this\.hiddenMicRecoveryOwner[\s\S]*micRecoveryOwner = 0[\s\S]*\+\+this\.micRecoverySeq/,
  'foreground must generation-fence an old automatic recovery owner');
const micFallback = methodText('startMicWithDefaultFallback');
assert.match(micFallback, /foregroundGeneration !== this\.micForegroundGeneration[\s\S]*this\.micEpoch !== attemptMicEpoch[\s\S]*getSettings\(\)\.input !== selectedInput/,
  'a stale selected-device error must not erase a newer input or start fallback capture');
const hiddenRepublish = methodText('publishExistingMic');
assert.match(hiddenRepublish, /voiceCaptureUnavailable\(\)[\s\S]*micForegroundRecoveryPending = true/,
  'hidden reconnect republish must retain foreground reacquire ownership');
assert.match(hiddenRepublish, /const preserveForegroundRecovery = this\.micForegroundRecoveryPending[\s\S]*if \(!preserveForegroundRecovery\) this\.micForegroundRecoveryPending = false/,
  'a visible verifier republish cannot consume recovery armed by the hidden lifecycle');

const inputLifecycle = methodText('ensureInputLifecycleListener');
assert.match(inputLifecycle, /window\.addEventListener\('pagehide', this\.inputPageHideHandler\)/,
  'settings preview and pre-join voice lifecycle must observe pagehide');
assert.match(inputLifecycle, /if \(this\.inVoice\) \{ this\.onVisible\(\); return; \}/,
  'an early join pageshow must clear the pagehide fence before startConnPoll is installed');
const levelMeter = methodText('startLevelMeter');
assert.match(levelMeter, /levelStartOwner/,
  'settings preview capture must have exact single-flight ownership');
assert.ok(levelMeter.indexOf('fenceAfterAwait') < levelMeter.indexOf('navigator.mediaDevices.getUserMedia')
  && levelMeter.lastIndexOf('fenceAfterAwait') > levelMeter.indexOf('createDenoiseNode'),
  'settings preview must visibility-fence every deferred capture/AudioContext/denoise phase');
assert.ok(levelMeter.indexOf('this.levelStream = stream') > levelMeter.lastIndexOf('if (!current() || document.hidden)'),
  'settings preview resources must commit only after the final hidden/generation fence');
assert.match(joinVoiceText, /this\.stopLevelMeter\(\)/,
  'joining voice must synchronously retire settings-only microphone capture');
assert.match(methodText('scheduleLevelMeterAfterVoiceExit'), /engineLifecycleActive[\s\S]*voiceEpoch !== expectedVoiceEpoch[\s\S]*this\.inVoice/,
  'preview restart after voice exit must be fenced against logout, rejoin and stale teardown');
assert.match(methodText('disconnect'), /engineLifecycleActive = false[\s\S]*stopLevelMeter\(\)/,
  'logout/full disconnect must fence preview resurrection before teardown');

const terminalMediaLoss = methodText('handleVoiceMediaDisconnected');
assert.doesNotMatch(terminalMediaLoss, /disconnectRoom\(this\.viewRoom\)|this\.disconnect\(\)/,
  'terminal media loss must not tear down the viewed hub or account engine');

console.log('voice media isolation: ok');
