# WeChat-AI (iLink + Redis + LINUX DO OAuth)
#
# Prefer host wrappers (bump + OTA pack + docker):
#   pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .
#   pnpm docker:up
# Publish channel: /admin → 上传通道包 (dist/release/<ver>/files.json)
# Plain `docker build` does NOT bump or pack.
#
# 必填环境变量见 .env.example / docs/docker.md

FROM docker.1panel.live/library/node:22-bookworm-slim

# China-friendly defaults keep production rebuilds independent of overseas
# registries. Both remain overridable for non-China build environments.
ARG NPM_REGISTRY=https://registry.npmmirror.com
# The slim base does not yet contain system CA certificates. Use Aliyun's
# signed HTTP Debian repository to bootstrap ca-certificates without a TLS
# dependency cycle; apt still verifies repository metadata via Debian GPG.
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com/debian

LABEL org.opencontainers.image.title="wechat-ai" \
      org.opencontainers.image.description="WeChat roleplay bots via iLink, Redis, LINUX DO OAuth"

# Keep pnpm's writable home under /pnpm so the non-root runtime user can use it
# without writing to /home/appuser/.cache (which caused EACCES).
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    WECHAT_AI_HOST=0.0.0.0 \
    WECHAT_AI_PORT=8787 \
    npm_config_registry=$NPM_REGISTRY

RUN sed -i "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g; s|http://deb.debian.org/debian-security|${DEBIAN_MIRROR}-security|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && npm install --global pnpm@11.15.0 --registry="${NPM_REGISTRY}" \
  && pnpm --version \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer cache)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/ilink/package.json ./packages/ilink/
COPY packages/llm/package.json ./packages/llm/

# tsx is a runtime dependency of @wechat-ai/api; install all workspace packages
RUN pnpm install --frozen-lockfile

# Application source (TypeScript run via tsx)
COPY apps/api ./apps/api
COPY packages ./packages
COPY scripts ./scripts

# Non-root user + writable home for tools
RUN mkdir -p /home/appuser \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /home/appuser --no-create-home appuser \
  && chown -R appuser:nodejs /app /pnpm /home/appuser

USER appuser

EXPOSE 8787

# scrypt (login + provider-secret KDF) runs on the libuv pool; the default 4
# threads let a login burst queue behind itself.
ENV UV_THREADPOOL_SIZE=16

HEALTHCHECK --interval=30s --timeout=8s --start-period=50s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WECHAT_AI_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run node as PID 1 so SIGTERM reaches the process and the graceful shutdown
# in index.ts actually runs (releasing bot leases). `sh -c` swallowed it, so
# every deploy left up to LEASE_TTL_SEC of bots that no node was polling.
# The separate seed step is gone — index.ts already calls seedPersonas().
# WORKDIR is apps/api because tsx is linked under apps/api/node_modules;
# resolveRepoRoot() still walks up to /app for .env and OTA paths.
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/index.ts"]
