FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.js tree.js turnCreds.js stats.js .
EXPOSE 3000
CMD ["node","index.js"]
