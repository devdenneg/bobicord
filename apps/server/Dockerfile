FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js auth.js authSessions.js bootstrap-admin.js mailer.js vrelayAuth.js runtimeRevocation.js tree.js turnCreds.js stats.js voiceLease.js voiceMedia.js voiceMediaRevocations.js voiceAuthRegistry.js voiceTokenPolicy.js chatRealtime.js legacyChatBridge.js pushSubscriptions.js serverSettings.js releaseNotes.js uploadsGc.js seventvProxy.js diagStore.js voiceDiagnostics.js publish-release.js .
EXPOSE 3000
CMD ["node","index.js"]
