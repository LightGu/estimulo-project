FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node . .
RUN mkdir -p /app/storage && chown -R node:node /app

USER node
EXPOSE 3000

CMD ["node", "scripts/start-api.js"]
