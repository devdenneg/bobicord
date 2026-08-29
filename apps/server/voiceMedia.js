'use strict';

const { TrackSource } = require('livekit-server-sdk');

function voiceMediaRoomName(serverId, channelId) {
  return `voice:${serverId}:${channelId}`;
}

function voiceHubIdentity(username, sessionId) {
  return `${username}#${sessionId}`;
}

function voiceMediaIdentity(username, sessionId, epoch) {
  return `${voiceHubIdentity(username, sessionId)}~${epoch}`;
}

function exactVoiceLease(lease, { sessionId, serverId, channelId, epoch }) {
  return !!lease
    && lease.sessionId === sessionId
    && lease.serverId === serverId
    && lease.channelId === channelId
    && lease.epoch === epoch;
}

function initialVoiceMediaGrant(room) {
  return {
    roomJoin: true,
    room,
    canPublish: false,
    canSubscribe: false,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  };
}

function activeVoiceMediaPermission() {
  return {
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    canPublishSources: [TrackSource.MICROPHONE],
    hidden: false,
    recorder: false,
    canUpdateMetadata: false,
  };
}

async function activateVoiceMediaParticipant(roomService, room, identity) {
  await roomService.getParticipant(room, identity);
  return roomService.updateParticipant(room, identity, { permission: activeVoiceMediaPermission() });
}

async function removeVoiceMediaParticipant(roomService, room, identity, nowMs = Date.now()) {
  // +1 fences a token minted during the same Unix second. Media identities are epoch-scoped,
  // so the small future cutoff can never revoke the next valid lease identity.
  const revokeTokenTs = BigInt(Math.max(0, Math.floor(nowMs / 1000) + 1));
  return roomService.removeParticipant(room, identity, { revokeTokenTs });
}

module.exports = {
  TrackSource,
  voiceMediaRoomName,
  voiceHubIdentity,
  voiceMediaIdentity,
  exactVoiceLease,
  initialVoiceMediaGrant,
  activeVoiceMediaPermission,
  activateVoiceMediaParticipant,
  removeVoiceMediaParticipant,
};
