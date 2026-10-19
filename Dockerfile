# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine
LABEL org.opencontainers.image.title="artifacts" \
      org.opencontainers.image.description="Versioned documents that people and coding agents publish, find and share" \
      org.opencontainers.image.source="https://github.com/ly-solutions/artifacts" \
      org.opencontainers.image.licenses="Apache-2.0"
# git is only needed by `artifacts migrate --from-git`.
RUN apk add --no-cache git tini \
 && mkdir -p /data \
 && chown node:node /data
WORKDIR /app
ENV NODE_ENV=production \
    ARTIFACTS_PORT=8080 \
    ARTIFACTS_DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE README.md ./
COPY bin ./bin
COPY src ./src
COPY web ./web
COPY skills ./skills
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ARTIFACTS_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/bin/artifacts.mjs"]
CMD ["serve"]
