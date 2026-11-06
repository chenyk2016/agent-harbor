FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
ARG BUILD_PROXY
ENV HTTP_PROXY=${BUILD_PROXY} HTTPS_PROXY=${BUILD_PROXY}
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat python3 git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /platform/runtime
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --workspaces=false --registry=https://registry.npmjs.org
COPY dist/src ./dist/src
COPY LICENSE NOTICE ./
COPY LICENSES ./LICENSES
COPY infra/managed-settings.json /etc/claude-code/managed-settings.json
RUN mkdir -p /workspace /platform/state /platform/run && chown node:node /workspace /platform/state
ENV HTTP_PROXY= HTTPS_PROXY= HOME=/platform/state LANG=C.UTF-8 CLAUDE_CONFIG_DIR=/platform/state
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/platform/runtime/dist/src/agent/runner.js"]
