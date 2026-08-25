# syntax=docker/dockerfile:1

FROM node:22-alpine

# tini reaps zombies and forwards SIGTERM to the bot, so `docker compose stop`
# lets it release its lock and exit cleanly instead of being killed.
RUN apk add --no-cache tini

WORKDIR /app

# Dependencies first, so source edits do not invalidate the install layer.
COPY package.json package-lock.json ./
# --include=dev is required, not incidental: the bot runs its TypeScript through
# tsx, which is a devDependency. Omitting it produces an image that installs
# cleanly and then cannot start.
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The state directory holds the managed position id, the running fee total and
# the regime price window. It is a mounted volume in compose; create it here so
# the image also works standalone.
RUN mkdir -p /app/state && chown -R node:node /app

# Never run a key-holding process as root.
USER node

# Set after install, so it cannot influence which dependencies were fetched.
ENV NODE_ENV=production \
    STATE_FILE=/app/state/position.json \
    LP_SEED_FILE=/app/state/seed-5m.csv \
    MODE=lp-live

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
