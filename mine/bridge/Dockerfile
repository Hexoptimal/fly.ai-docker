# The project's mining bridges (mine/bridge/start.ts): they hold the pool connections and feed house orders to the
# fleet. Deploy with mine/bridge/deploy.sh. No database and no connectome: the bridges only need the miner program
# files, the shared code they import, and the two @noble libraries the server's package.json already pins.
FROM node:22-slim

WORKDIR /app
COPY mine/package.json mine/package-lock.json mine/
RUN cd mine && npm ci --omit=dev
COPY mine/src mine/src
COPY mine/web mine/web
COPY mine/examples mine/examples
COPY mine/bridge mine/bridge

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA PORT=8080

WORKDIR /app/mine
CMD ["node", "--disable-warning=ExperimentalWarning", "bridge/start.ts"]
