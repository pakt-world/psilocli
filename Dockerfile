FROM node:20-alpine

# Docker CLI required for --sandbox openclaw (daemon calls `docker exec` into the openclaw container).
# When the channel-http plugin is ready, switch to --sandbox hermes and remove this line.
RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY channel-pakt-daemon.mjs ./

ENTRYPOINT ["node", "/app/channel-pakt-daemon.mjs"]
