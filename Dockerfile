FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/brainstorm.db TRUST_PROXY=1
EXPOSE 3000
CMD ["node", "--import", "tsx", "server/index.ts"]
