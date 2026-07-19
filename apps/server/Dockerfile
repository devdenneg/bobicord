FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js auth.js bootstrap-admin.js mailer.js vrelayAuth.js runtimeRevocation.js tree.js turnCreds.js stats.js voiceLease.js releaseNotes.js publish-release.js .
EXPOSE 3000
CMD ["node","index.js"]
