FROM node:22-bookworm-slim
WORKDIR /app
# better-sqlite3 compiles from source when no prebuilt binary matches, which needs a toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
# The public web address (for canonical links, the sitemap and share images). Pass it as a build argument or env var.
ARG SITE_URL
ENV SITE_URL=${SITE_URL}
RUN npm run build
ENV NODE_ENV=production PORT=3000 TRUST_PROXY=1
EXPOSE 3000
CMD ["node", "--import", "tsx", "server/index.ts"]
