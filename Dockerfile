FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && mkdir -p public && npm pack --pack-destination public --silent && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=:: \
    PORT=3000 \
    DATA_DIR=/data \
    IK_CACHE_DIR=/data/cache \
    IK_DOWNLOAD_DIR=/data/downloads
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/index.js"]
