# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base

RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM deps AS build

COPY . .

# Pre-download any plugin files (safe even if none are required).
RUN npm run download-files

FROM base AS runner

ARG UID=10001
RUN useradd -m -d /app -s /usr/sbin/nologin -u ${UID} appuser

WORKDIR /app
COPY --from=build --chown=appuser:appuser /app /app

USER appuser
ENV NODE_ENV=production

# "start" runs the agent server in production mode and waits for jobs from LiveKit Cloud.
CMD ["node", "agent-server.mjs", "start"]

