# fly.ai mining server. Deploy with mine/deploy.sh, which stages the server, the two world engine files it
# imports and serves, and the connectome export (~58 MB), then builds remotely. The server
# needs only the two @noble crypto libraries (Node strips the TypeScript itself).
FROM node:22-slim

WORKDIR /app
COPY world/src/connectome.ts world/src/rng.ts world/src/
COPY world/public/connectome world/public/connectome
COPY mine/package.json mine/package-lock.json mine/
RUN cd mine && npm ci --omit=dev
COPY mine/src mine/src
COPY mine/web mine/web

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA PORT=8080 MINE_DB=/data/mine.db TRUST_PROXY=1

WORKDIR /app/mine
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
