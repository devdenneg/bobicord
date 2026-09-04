const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

// The regression concerns the server-first topology regardless of a deployer's shell environment.
process.env.TREE_SERVER_FIRST = '1';
const { attachTreeServer } = require('./tree');

const SECRET = 'tree-track-missing-test-secret';

function waitForMessage(ws, predicate, label, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      if (error) reject(error); else resolve(value);
    };
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (predicate(message)) finish(null, message);
    };
    const onClose = () => finish(new Error(`socket closed while waiting for ${label}`));
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${label}`)), timeoutMs);
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function send(ws, message) {
  ws.send(JSON.stringify(message));
}

async function waitForCondition(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('track-missing recovery is rate-limited and only trusted ingest opens a global circuit', async (t) => {
  const server = http.createServer();
  const tree = attachTreeServer(server, { sessionSecret: SECRET, path: '/tree' });
  const sockets = [];

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const timer of [tree.abrTimer, tree.hbTimer, tree.drainTimer, tree.renditionTimer]) {
      if (timer) clearInterval(timer);
    }
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /** already closed */ }
    }
    try { tree.wss.close(); } catch { /** already closed */ }
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  const token = (uid) => jwt.sign({ id: uid }, SECRET, { expiresIn: 300 });
  const connect = async (uid) => {
    const address = server.address();
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/tree?token=${token(uid)}`);
    sockets.push(ws);
    // Keep a permanent error listener so cleanup races cannot surface as an uncaught EventEmitter error.
    ws.on('error', () => {});
    const welcome = await waitForMessage(ws, (message) => message.t === 'welcome', 'welcome');
    return { ws, id: welcome.id };
  };

  const agent = await connect('virtual-relay');
  send(agent.ws, { t: 'vrelay-hello', capacity: 8, maxTranscodes: 0 });
  await waitForCondition(() => tree.peers.get(agent.id)?.isVrelayAgent, 'vrelay control registration');

  const createStream = async (streamId, broadcasterCapacity, viewerNative = true) => {
    const broadcaster = await connect(`broadcaster-${streamId}`);
    const ingest = waitForMessage(
      agent.ws,
      (message) => message.t === 'vrelay-ingest' && message.streamId === streamId,
      `vrelay-ingest ${streamId}`,
    );
    send(broadcaster.ws, {
      t: 'join', streamId, role: 'broadcaster', native: true, serverIngest: true,
      maxChildren: broadcasterCapacity, identity: `broadcaster-${streamId}`,
      abr: true, maxBitrate: 4_500_000,
    });
    await ingest;

    const vrelay = await connect('virtual-relay');
    const vrelayParent = waitForMessage(
      vrelay.ws,
      (message) => message.t === 'assign-parent' && message.streamId === streamId,
      `vrelay parent ${streamId}`,
    );
    const rootGetsVrelay = waitForMessage(
      broadcaster.ws,
      (message) => message.t === 'assign-child' && message.streamId === streamId
        && message.childId === vrelay.id,
      `root gets vrelay ${streamId}`,
    );
    send(vrelay.ws, {
      t: 'join', streamId, role: 'viewer', native: true, virtual: true,
      maxChildren: 8, identity: 'server',
    });
    assert.equal((await vrelayParent).parentId, broadcaster.id);
    await rootGetsVrelay;

    const viewer = await connect(`viewer-${streamId}`);
    const viewerParent = waitForMessage(
      viewer.ws,
      (message) => message.t === 'assign-parent' && message.streamId === streamId,
      `viewer parent ${streamId}`,
    );
    const vrelayGetsViewer = waitForMessage(
      vrelay.ws,
      (message) => message.t === 'assign-child' && message.streamId === streamId
        && message.childId === viewer.id,
      `vrelay gets viewer ${streamId}`,
    );
    send(viewer.ws, {
      t: 'join', streamId, role: 'viewer', native: viewerNative,
      maxChildren: 1, identity: `viewer-${streamId}`,
    });
    assert.equal((await viewerParent).parentId, vrelay.id,
      'a fresh server-first viewer starts under vrelay');
    await vrelayGetsViewer;
    return { streamId, broadcaster, vrelay, viewer };
  };

  const expectCooldown = async (fixture, reason) => {
    const viewerNode = tree.peers.get(fixture.viewer.id);
    const denied = waitForMessage(
      fixture.viewer.ws,
      (message) => message.t === 'reparent-denied' && message.streamId === fixture.streamId,
      `${reason || 'ordinary'} cooldown`,
    );
    send(fixture.viewer.ws, {
      t: 'request-reparent', streamId: fixture.streamId,
      ...(reason ? { reason } : {}),
      ...(reason === 'track-missing' && viewerNode?.parent
        ? { failedParentId: viewerNode.parent }
        : {}),
    });
    assert.equal((await denied).reason, 'cooldown');
  };

  // A browser cannot opt out of drain hysteresis merely by copying the public reason string
  // immediately. Even after the minimum delay, an observed offer makes the no-offer claim false.
  const browser = await createStream('track-missing-browser', 1, false);
  let browserTopologyChanges = 0;
  const countBrowserChange = (raw) => {
    const message = JSON.parse(raw.toString());
    if ((message.t === 'assign-parent' || message.t === 'drop-peer' || message.t === 'assign-child')
      && message.streamId === browser.streamId) browserTopologyChanges += 1;
  };
  browser.viewer.ws.on('message', countBrowserChange);
  browser.vrelay.ws.on('message', countBrowserChange);
  await expectCooldown(browser, 'track-missing');
  await new Promise((resolve) => setTimeout(resolve, 50));
  browser.viewer.ws.off('message', countBrowserChange);
  browser.vrelay.ws.off('message', countBrowserChange);
  assert.equal(browserTopologyChanges, 0,
    'an early browser track-missing cannot bypass drain cooldown');
  const browserNode = tree.peers.get(browser.viewer.id);
  assert.ok(browserNode, 'the browser viewer remains registered');
  assert.equal(tree.mgr.trees.get(`${browser.streamId}::source`)?.vrelayNoOfferFailures || 0, 0,
    'an early browser claim does not consume the terminal circuit budget');
  const forwardedOffer = waitForMessage(
    browser.viewer.ws,
    (message) => message.t === 'sdp' && message.type === 'offer'
      && message.from === browser.vrelay.id,
    'browser receives parent offer',
  );
  send(browser.vrelay.ws, {
    t: 'sdp', streamId: browser.streamId, to: browser.viewer.id,
    type: 'offer', sdp: 'test-offer',
  });
  await forwardedOffer;
  await expectCooldown(browser, 'track-missing');
  assert.equal(tree.mgr.trees.get(`${browser.streamId}::source`)?.vrelayTrackMissingUids?.size || 0, 0,
    'an offer does not let the decoded-frame claim bypass its 12 second deadline');

  // Conversely, the server can prove a web/PWA no-offer stall without trusting UA strings. Each
  // bounded report may recreate that exact viewer link, but never quarantines a vrelay which may
  // still be serving every other viewer correctly.
  const webNoOffer = await createStream('track-missing-web-no-offer', 1, false);
  const webNode = tree.peers.get(webNoOffer.viewer.id);
  assert.ok(webNode, 'the no-offer browser viewer remains registered');
  webNode.parentAssignedAt = Date.now() - 60_000;
  const webFirstDrop = waitForMessage(
    webNoOffer.vrelay.ws,
    (message) => message.t === 'drop-peer' && message.streamId === webNoOffer.streamId
      && message.peerId === webNoOffer.viewer.id,
    'web no-offer first drop',
  );
  const webFirstAssignment = waitForMessage(
    webNoOffer.viewer.ws,
    (message) => message.t === 'assign-parent' && message.streamId === webNoOffer.streamId,
    'web no-offer first assignment',
  );
  const webFirstRecreate = waitForMessage(
    webNoOffer.vrelay.ws,
    (message) => message.t === 'assign-child' && message.streamId === webNoOffer.streamId
      && message.childId === webNoOffer.viewer.id,
    'web no-offer first recreate',
  );
  send(webNoOffer.viewer.ws, {
    t: 'request-reparent', streamId: webNoOffer.streamId, reason: 'track-missing',
    failedParentId: webNoOffer.vrelay.id,
  });
  await webFirstDrop;
  assert.equal((await webFirstAssignment).parentId, webNoOffer.vrelay.id,
    'a server-confirmed browser no-offer stall bypasses the fresh-child cooldown');
  await webFirstRecreate;
  const webNoOfferTree = tree.mgr.trees.get(`${webNoOffer.streamId}::source`);
  assert.equal(webNoOfferTree?.vrelayTrustedFailures || 0, 0,
    'a browser no-offer report is not trusted global ingest evidence');

  webNode.trackMissingRecoveryUntil = 0;
  webNode.parentAssignedAt = Date.now() - 60_000;
  const webSecondDrop = waitForMessage(
    webNoOffer.vrelay.ws,
    (message) => message.t === 'drop-peer' && message.streamId === webNoOffer.streamId
      && message.peerId === webNoOffer.viewer.id,
    'web no-offer second drop',
  );
  const webSecondAssignment = waitForMessage(
    webNoOffer.viewer.ws,
    (message) => message.t === 'assign-parent' && message.streamId === webNoOffer.streamId,
    'web no-offer second assignment',
  );
  const webSecondRecreate = waitForMessage(
    webNoOffer.vrelay.ws,
    (message) => message.t === 'assign-child' && message.streamId === webNoOffer.streamId
      && message.childId === webNoOffer.viewer.id,
    'web no-offer second recreate',
  );
  send(webNoOffer.viewer.ws, {
    t: 'request-reparent', streamId: webNoOffer.streamId, reason: 'track-missing',
    failedParentId: webNoOffer.vrelay.id,
  });
  await webSecondDrop;
  assert.equal((await webSecondAssignment).parentId, webNoOffer.vrelay.id,
    'a repeated PWA/browser failure rebuilds only its own exact link');
  await webSecondRecreate;
  assert.equal(webNoOfferTree?.vrelayMediaCircuitOpen, undefined,
    'repeated browser no-offer evidence cannot disable a working vrelay globally');
  assert.equal(webNoOfferTree?.nodes.has(webNoOffer.vrelay.id), true);

  // With the broadcaster's only slot occupied by vrelay, no alternate parent exists. Ordinary,
  // manual and frame-drop requests remain fenced, while track-missing recreates the same link.
  const sameParent = await createStream('track-missing-reattach', 1);
  const sameParentNode = tree.peers.get(sameParent.viewer.id);
  assert.ok(sameParentNode, 'the recovering viewer remains registered');
  const firstOffer = waitForMessage(
    sameParent.viewer.ws,
    (message) => message.t === 'sdp' && message.type === 'offer'
      && message.from === sameParent.vrelay.id,
    'first native viewer offer',
  );
  send(sameParent.vrelay.ws, {
    t: 'sdp', streamId: sameParent.streamId, to: sameParent.viewer.id,
    type: 'offer', sdp: 'native-offer-1',
  });
  await firstOffer;
  await expectCooldown(sameParent);
  await expectCooldown(sameParent, 'manual');
  await expectCooldown(sameParent, 'frame-drops');

  sameParentNode.parentAssignedAt = Date.now() - 60_000;
  const oldParentDrops = waitForMessage(
    sameParent.vrelay.ws,
    (message) => message.t === 'drop-peer' && message.streamId === sameParent.streamId
      && message.peerId === sameParent.viewer.id,
    'same-parent drop-peer',
  );
  const viewerReassigned = waitForMessage(
    sameParent.viewer.ws,
    (message) => message.t === 'assign-parent' && message.streamId === sameParent.streamId,
    'same-parent assign-parent',
  );
  const oldParentRecreates = waitForMessage(
    sameParent.vrelay.ws,
    (message) => message.t === 'assign-child' && message.streamId === sameParent.streamId
      && message.childId === sameParent.viewer.id,
    'same-parent assign-child',
  );
  send(sameParent.viewer.ws, {
    t: 'request-reparent', streamId: sameParent.streamId, reason: 'track-missing',
    failedParentId: sameParent.vrelay.id,
  });
  await oldParentDrops;
  assert.equal((await viewerReassigned).parentId, sameParent.vrelay.id,
    'track-missing rebuilds the upstream even inside fresh-viewer drain cooldown');
  await oldParentRecreates;

  const secondOffer = waitForMessage(
    sameParent.viewer.ws,
    (message) => message.t === 'sdp' && message.type === 'offer'
      && message.from === sameParent.vrelay.id,
    'second native viewer offer',
  );
  send(sameParent.vrelay.ws, {
    t: 'sdp', streamId: sameParent.streamId, to: sameParent.viewer.id,
    type: 'offer', sdp: 'native-offer-2',
  });
  await secondOffer;
  sameParentNode.parentAssignedAt = Date.now() - 60_000;

  let unexpectedRecreate = 0;
  const countViewerRecreate = (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.t === 'assign-parent' && message.streamId === sameParent.streamId) unexpectedRecreate += 1;
  };
  const countParentRecreate = (raw) => {
    const message = JSON.parse(raw.toString());
    if ((message.t === 'drop-peer' || message.t === 'assign-child')
      && message.streamId === sameParent.streamId) unexpectedRecreate += 1;
  };
  sameParent.viewer.ws.on('message', countViewerRecreate);
  sameParent.vrelay.ws.on('message', countParentRecreate);
  await expectCooldown(sameParent, 'track-missing');
  await new Promise((resolve) => setTimeout(resolve, 50));
  sameParent.viewer.ws.off('message', countViewerRecreate);
  sameParent.vrelay.ws.off('message', countParentRecreate);
  assert.equal(unexpectedRecreate, 0, 'repeat track-missing cannot create a reparent storm');

  // A second watchdog epoch from the same account may recreate its own link, but cannot globally
  // disable server-first for everybody.
  sameParentNode.trackMissingRecoveryUntil = 0;
  sameParentNode.parentAssignedAt = Date.now() - 60_000;
  const secondSameUidDrop = waitForMessage(
    sameParent.vrelay.ws,
    (message) => message.t === 'drop-peer' && message.streamId === sameParent.streamId
      && message.peerId === sameParent.viewer.id,
    'second same-uid drop',
  );
  const secondSameUidAssignment = waitForMessage(
    sameParent.viewer.ws,
    (message) => message.t === 'assign-parent' && message.streamId === sameParent.streamId,
    'second same-uid assignment',
  );
  send(sameParent.viewer.ws, {
    t: 'request-reparent', streamId: sameParent.streamId, reason: 'track-missing',
    failedParentId: sameParent.vrelay.id,
  });
  await secondSameUidDrop;
  assert.equal((await secondSameUidAssignment).parentId, sameParent.vrelay.id);
  const sameParentTree = tree.mgr.trees.get(`${sameParent.streamId}::source`);
  assert.equal(sameParentTree.vrelayMediaCircuitOpen, undefined,
    'one authenticated uid cannot open the global circuit');
  assert.equal(sameParentTree.vrelayTrustedFailures || 0, 0);

  // A second authenticated viewer independently receives an SDP offer but no decoded media.
  // This still proves only a viewer-specific path failure and must not evict a healthy vrelay.
  const corroborator = await connect(`corroborator-${sameParent.streamId}`);
  const corroboratorParent = waitForMessage(
    corroborator.ws,
    (message) => message.t === 'assign-parent' && message.streamId === sameParent.streamId,
    'corroborator parent',
  );
  send(corroborator.ws, {
    t: 'join', streamId: sameParent.streamId, role: 'viewer', native: false,
    maxChildren: 0, identity: `corroborator-${sameParent.streamId}`,
  });
  assert.equal((await corroboratorParent).parentId, sameParent.vrelay.id);
  const corroboratorOffer = waitForMessage(
    corroborator.ws,
    (message) => message.t === 'sdp' && message.type === 'offer'
      && message.from === sameParent.vrelay.id,
    'corroborator offer',
  );
  send(sameParent.vrelay.ws, {
    t: 'sdp', streamId: sameParent.streamId, to: corroborator.id,
    type: 'offer', sdp: 'browser-offer-without-frames',
  });
  await corroboratorOffer;
  tree.peers.get(corroborator.id).parentAssignedAt = Date.now() - 60_000;

  const corroboratorDrop = waitForMessage(
    sameParent.vrelay.ws,
    (message) => message.t === 'drop-peer' && message.streamId === sameParent.streamId
      && message.peerId === corroborator.id,
    'corroborator same-parent drop',
  );
  const corroboratorReassigned = waitForMessage(
    corroborator.ws,
    (message) => message.t === 'assign-parent' && message.streamId === sameParent.streamId,
    'corroborator same-parent assignment',
  );
  const corroboratorRecreated = waitForMessage(
    sameParent.viewer.ws,
    (message) => message.t === 'assign-child' && message.streamId === sameParent.streamId
      && message.childId === corroborator.id,
    'corroborator alternate-parent attach',
  );
  send(corroborator.ws, {
    t: 'request-reparent', streamId: sameParent.streamId, reason: 'track-missing',
    failedParentId: sameParent.vrelay.id,
  });
  await corroboratorDrop;
  assert.equal((await corroboratorReassigned).parentId, sameParent.viewer.id,
    'a second viewer may switch its own branch to an available healthy relay');
  await corroboratorRecreated;
  assert.equal(sameParentTree.vrelayMediaCircuitOpen, undefined,
    'two independent viewer failures are insufficient for global quarantine');
  assert.equal(sameParentTree.nodes.has(sameParent.vrelay.id), true,
    'the vrelay remains available to viewers which are still receiving media');

  // The audio-only production failure is visible first to the trusted source-vrelay itself:
  // broadcaster SDP/audio can be alive while video RTP is absent. Its first bounded watchdog
  // epoch only recreates the direct ingest link; the second opens the circuit. A duplicate
  // stream socket already racing in the tree is released atomically with the reported one.
  const audioOnly = await createStream('track-missing-audio-only-ingest', 1);
  const audioOnlyTree = tree.mgr.trees.get(`${audioOnly.streamId}::source`);
  const ingestNode = tree.peers.get(audioOnly.vrelay.id);
  ingestNode.parentAssignedAt = Date.now() - 60_000;
  const ingestFirstDrop = waitForMessage(
    audioOnly.broadcaster.ws,
    (message) => message.t === 'drop-peer' && message.streamId === audioOnly.streamId
      && message.peerId === audioOnly.vrelay.id,
    'trusted ingest first drop',
  );
  const ingestFirstAssignment = waitForMessage(
    audioOnly.vrelay.ws,
    (message) => message.t === 'assign-parent' && message.streamId === audioOnly.streamId,
    'trusted ingest first assignment',
  );
  send(audioOnly.vrelay.ws, {
    t: 'request-reparent', streamId: audioOnly.streamId, reason: 'track-missing',
    failedParentId: audioOnly.broadcaster.id,
  });
  await ingestFirstDrop;
  assert.equal((await ingestFirstAssignment).parentId, audioOnly.broadcaster.id,
    'trusted ingest recovery preserves the direct-root invariant');
  assert.equal(audioOnlyTree.vrelayTrustedFailures, 1);
  assert.equal(audioOnlyTree.vrelayMediaCircuitOpen, undefined);

  const duplicateIngest = await connect('virtual-relay');
  const duplicateAssigned = waitForMessage(
    duplicateIngest.ws,
    (message) => message.t === 'assign-parent' && message.streamId === audioOnly.streamId,
    'racing duplicate vrelay assignment',
  );
  send(duplicateIngest.ws, {
    t: 'join', streamId: audioOnly.streamId, role: 'viewer', native: true, virtual: true,
    maxChildren: 8, identity: 'server-duplicate',
  });
  assert.equal((await duplicateAssigned).parentId, null,
    'a duplicate vrelay waits as an orphan while the direct ingest is present');

  audioOnlyTree.renditions = new Map([
    ['480', { state: 'live', lastConsumerAt: Date.now(), presetBitrate: 1_500_000 }],
  ]);
  ingestNode.trackMissingRecoveryUntil = 0;
  ingestNode.parentAssignedAt = Date.now() - 60_000;
  const primaryRelease = waitForMessage(
    audioOnly.vrelay.ws,
    (message) => message.t === 'vrelay-release' && message.streamId === audioOnly.streamId,
    'trusted ingest terminal release',
  );
  const duplicateRelease = waitForMessage(
    duplicateIngest.ws,
    (message) => message.t === 'vrelay-release' && message.streamId === audioOnly.streamId,
    'duplicate ingest terminal release',
  );
  const renditionStop = waitForMessage(
    agent.ws,
    (message) => message.t === 'vrelay-rendition-stop'
      && message.streamId === audioOnly.streamId && message.rendition === '480',
    'derived rendition stop',
  );
  const audioOnlyViewerFallback = waitForMessage(
    audioOnly.viewer.ws,
    (message) => message.t === 'assign-parent' && message.streamId === audioOnly.streamId,
    'audio-only viewer fallback',
  );
  send(audioOnly.vrelay.ws, {
    t: 'request-reparent', streamId: audioOnly.streamId, reason: 'track-missing',
    failedParentId: audioOnly.broadcaster.id,
  });
  await primaryRelease;
  await duplicateRelease;
  await renditionStop;
  assert.equal((await audioOnlyViewerFallback).parentId, audioOnly.broadcaster.id);
  assert.equal(audioOnlyTree.vrelayMediaCircuitOpen, true);
  assert.equal(audioOnlyTree.renditions.size, 0,
    'source circuit clears stale live rendition state immediately');
  assert.equal([...audioOnlyTree.nodes.values()].some((node) => node.virtual), false,
    'all pre-existing virtual sockets are removed before orphan settlement');
  await waitForCondition(
    () => !tree.peers.has(audioOnly.vrelay.id) && !tree.peers.has(duplicateIngest.id),
    'all quarantined vrelay peers removed',
  );

  const staleRenditionViewer = await connect(`stale-rendition-${audioOnly.streamId}`);
  const staleRenditionDenied = waitForMessage(
    staleRenditionViewer.ws,
    (message) => message.t === 'rendition-unavailable' && message.streamId === audioOnly.streamId,
    'stale rendition rejected',
  );
  send(staleRenditionViewer.ws, {
    t: 'join', streamId: audioOnly.streamId, quality: '480', role: 'viewer', native: false,
    maxChildren: 0, identity: `stale-rendition-${audioOnly.streamId}`,
  });
  assert.equal((await staleRenditionDenied).reason, 'source-quarantined');
  assert.equal(tree.peers.get(staleRenditionViewer.id).treeKey, null,
    'late rendition consumer never enters a quarantined derived tree');

  // Browser and installed-PWA viewers are protocol-identical leaves (native:false, capacity 0).
  // If a terminal ingest circuit opens while a one-slot broadcaster has several such viewers,
  // exactly one can use the honest direct slot. The rest must receive an explicit terminal result
  // and leave server state rather than remaining immortal parentless nodes.
  const browserFanout = await createStream('track-missing-browser-fanout', 1, false);
  const addBrowserLeaf = async (suffix) => {
    const viewer = await connect(`browser-${suffix}`);
    const assigned = waitForMessage(
      viewer.ws,
      (message) => message.t === 'assign-parent' && message.streamId === browserFanout.streamId,
      `browser ${suffix} parent`,
    );
    const relayAssigned = waitForMessage(
      browserFanout.vrelay.ws,
      (message) => message.t === 'assign-child' && message.streamId === browserFanout.streamId
        && message.childId === viewer.id,
      `vrelay gets browser ${suffix}`,
    );
    send(viewer.ws, {
      t: 'join', streamId: browserFanout.streamId, role: 'viewer', native: false,
      maxChildren: 0, identity: `browser-${suffix}`,
    });
    assert.equal((await assigned).parentId, browserFanout.vrelay.id);
    await relayAssigned;
    return viewer;
  };
  const secondBrowser = await addBrowserLeaf('second');
  const thirdBrowser = await addBrowserLeaf('third');
  const browserFanoutTree = tree.mgr.trees.get(`${browserFanout.streamId}::source`);
  const browserFanoutIngest = tree.peers.get(browserFanout.vrelay.id);
  browserFanoutIngest.parentAssignedAt = Date.now() - 60_000;
  const browserFanoutFirstDrop = waitForMessage(
    browserFanout.broadcaster.ws,
    (message) => message.t === 'drop-peer' && message.streamId === browserFanout.streamId
      && message.peerId === browserFanout.vrelay.id,
    'browser fanout ingest first drop',
  );
  const browserFanoutFirstAssignment = waitForMessage(
    browserFanout.vrelay.ws,
    (message) => message.t === 'assign-parent' && message.streamId === browserFanout.streamId,
    'browser fanout ingest first assignment',
  );
  send(browserFanout.vrelay.ws, {
    t: 'request-reparent', streamId: browserFanout.streamId, reason: 'track-missing',
    failedParentId: browserFanout.broadcaster.id,
  });
  await browserFanoutFirstDrop;
  assert.equal((await browserFanoutFirstAssignment).parentId, browserFanout.broadcaster.id);

  browserFanoutIngest.trackMissingRecoveryUntil = 0;
  browserFanoutIngest.parentAssignedAt = Date.now() - 60_000;
  const browserViewers = [browserFanout.viewer, secondBrowser, thirdBrowser];
  const browserOutcomes = browserViewers.map((viewer) => waitForMessage(
    viewer.ws,
    (message) => message.streamId === browserFanout.streamId
      && ((message.t === 'assign-parent' && message.parentId === browserFanout.broadcaster.id)
        || message.t === 'stream-end'),
    `browser circuit outcome ${viewer.id}`,
  ).then((message) => ({ viewer, message })));
  const browserFanoutRelease = waitForMessage(
    browserFanout.vrelay.ws,
    (message) => message.t === 'vrelay-release' && message.streamId === browserFanout.streamId,
    'browser fanout terminal release',
  );
  send(browserFanout.vrelay.ws, {
    t: 'request-reparent', streamId: browserFanout.streamId, reason: 'track-missing',
    failedParentId: browserFanout.broadcaster.id,
  });
  await browserFanoutRelease;
  const outcomes = await Promise.all(browserOutcomes);
  const served = outcomes.filter(({ message }) => message.t === 'assign-parent');
  const refused = outcomes.filter(({ message }) => message.t === 'stream-end');
  assert.equal(served.length, 1, 'the declared broadcaster slot serves exactly one browser/PWA');
  assert.equal(refused.length, 2, 'excess browser/PWA leaves receive an explicit terminal result');
  assert.ok(refused.every(({ message }) => message.reason === 'no-fallback-capacity'),
    'terminal results explain that fallback capacity is unavailable');
  await waitForCondition(
    () => refused.every(({ viewer }) => !tree.peers.has(viewer.id)),
    'terminal browser/PWA viewers removed from peer registry',
  );
  assert.deepEqual(
    [...browserFanoutTree.nodes.values()].map((node) => node.id).sort(),
    [browserFanout.broadcaster.id, served[0].viewer.id].sort(),
    'the circuit retains only the broadcaster and the viewer with a real media path',
  );
  assert.equal(
    [...browserFanoutTree.nodes.values()].filter((node) => node.id !== browserFanoutTree.broadcasterId)
      .every((node) => tree.mgr.attachedToRoot(browserFanoutTree, node)),
    true,
    'the terminal circuit leaves no detached component in the topology',
  );

  const lateBrowser = await connect('browser-late-after-circuit');
  const lateParent = waitForMessage(
    lateBrowser.ws,
    (message) => message.t === 'assign-parent' && message.streamId === browserFanout.streamId,
    'late browser parent result',
  );
  const lateTerminal = waitForMessage(
    lateBrowser.ws,
    (message) => message.t === 'stream-end' && message.streamId === browserFanout.streamId,
    'late browser terminal result',
  );
  send(lateBrowser.ws, {
    t: 'join', streamId: browserFanout.streamId, role: 'viewer', native: false,
    maxChildren: 0, identity: 'browser-late-after-circuit',
  });
  assert.equal((await lateParent).parentId, null,
    'a late browser cannot be assigned beyond the broadcaster limit');
  assert.equal((await lateTerminal).reason, 'no-fallback-capacity',
    'a late browser receives the same explicit terminal refusal');
  await waitForCondition(() => !tree.peers.has(lateBrowser.id), 'late browser removed after refusal');

  // When the root has a spare slot, the same recovery changes upstream immediately instead of
  // waiting for DRAIN_COOLDOWN to expire.
  const alternate = await createStream('track-missing-switch', 2);
  tree.peers.get(alternate.viewer.id).parentAssignedAt = Date.now() - 60_000;
  const alternateDrops = waitForMessage(
    alternate.vrelay.ws,
    (message) => message.t === 'drop-peer' && message.streamId === alternate.streamId
      && message.peerId === alternate.viewer.id,
    'alternate drop-peer',
  );
  const alternateAssigned = waitForMessage(
    alternate.viewer.ws,
    (message) => message.t === 'assign-parent' && message.streamId === alternate.streamId,
    'alternate assign-parent',
  );
  const rootGetsViewer = waitForMessage(
    alternate.broadcaster.ws,
    (message) => message.t === 'assign-child' && message.streamId === alternate.streamId
      && message.childId === alternate.viewer.id,
    'alternate assign-child',
  );
  send(alternate.viewer.ws, {
    t: 'request-reparent', streamId: alternate.streamId, reason: 'track-missing',
    failedParentId: alternate.vrelay.id,
  });
  await alternateDrops;
  assert.equal((await alternateAssigned).parentId, alternate.broadcaster.id,
    'track-missing selects a different healthy upstream when one is available');
  await rootGetsViewer;
  await expectCooldown(alternate, 'frame-drops');
});
