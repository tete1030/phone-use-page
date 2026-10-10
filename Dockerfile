ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
FROM ${NODE_IMAGE} AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends adb ca-certificates python3 python3-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.lock /opt/requirements.lock
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r /opt/requirements.lock

FROM runtime-base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY bridge ./bridge
COPY tests ./tests
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build && PYTHON_PATH=/opt/venv/bin/python npm test \
    && /opt/venv/bin/python -m unittest discover -s tests -p 'test_*.py' \
    && npm prune --omit=dev

FROM runtime-base AS runtime
ARG APP_REVISION=unknown
LABEL org.opencontainers.image.title="Android Console" \
      org.opencontainers.image.revision="${APP_REVISION}"
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY bridge ./bridge
COPY web/template.html ./web/template.html
COPY vendor ./vendor
COPY --chmod=755 scripts/container-entrypoint.sh /usr/local/bin/console-entrypoint
COPY scripts/healthcheck.mjs ./scripts/healthcheck.mjs
RUN sha256sum -c vendor/SHA256SUMS
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8780 \
    PYTHON_PATH=/opt/venv/bin/python ADB_PATH=/usr/bin/adb \
    PYTHONDONTWRITEBYTECODE=1 LANG=C.UTF-8
USER node
EXPOSE 8780/tcp 50000-50031/udp
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
ENTRYPOINT ["console-entrypoint"]
CMD ["node", "dist/server.js"]
