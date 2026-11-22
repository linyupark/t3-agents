FROM node:24-bookworm-slim

# 系统依赖
# libatomic1: T3 Code 在 Linux 上的硬依赖
# ripgrep: Codex/OpenCode 搜索工具
# openssh-client: T3 Code SSH 远程环境连接
# Chrome 运行库 + 字体：T3 内置 headless Chrome 预览所需（对应 t3 browser setup）
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep curl ca-certificates libatomic1 openssh-client jq procps \
    gzip xz-utils unzip \
    libnss3 libglib2.0-0 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
    libdbus-1-3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxrandr2 libxkbcommon0 libgbm1 libasound2 libexpat1 \
    fontconfig fonts-liberation fonts-dejavu-core fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# workspace 是 bind mount，宿主 uid 与容器 root 不一致时 git 会报 dubious ownership；
# 这是单用户容器，直接在所有仓库上放行。
RUN printf '[safe]\n\tdirectory = *\n' > /etc/gitconfig

ARG INSTALL_T3=true
ARG INSTALL_CLAUDE=true
ARG INSTALL_CODEX=true
ARG INSTALL_OPENCODE=true
ARG INSTALL_PI=true
ARG INSTALL_MULTICA=true
ARG INSTALL_CDP_MCP=true

# 所有 npm 全局包安装到 /opt/agents（compose 里挂载为持久卷）
ENV PATH=/opt/agents/bin:/root/.local/bin:$PATH \
    IS_SANDBOX=1 \
    CLAUDE_CONFIG_DIR=/root/.claude \
    GIT_CONFIG_GLOBAL=/root/.config/git/gitconfig \
    DATA_DIR=/root/.agent-hub \
    LOG_DIR=/var/log/agent-hub

RUN mkdir -p /opt/agents /root/.local/bin /var/log/agent-hub /workspace

# ===== 控制面 =====
RUN if [ "$INSTALL_T3" = "true" ]; then npm install -g --prefix /opt/agents --no-fund --no-audit t3; fi

# ===== Agent CLI =====
RUN if [ "$INSTALL_CLAUDE" = "true" ]; then npm install -g --prefix /opt/agents --no-fund --no-audit @anthropic-ai/claude-code; fi
RUN if [ "$INSTALL_CODEX" = "true" ]; then npm install -g --prefix /opt/agents --no-fund --no-audit @openai/codex; fi
RUN if [ "$INSTALL_OPENCODE" = "true" ]; then npm install -g --prefix /opt/agents --no-fund --no-audit @opencode/cli; fi
RUN if [ "$INSTALL_PI" = "true" ]; then npm install -g --prefix /opt/agents --no-fund --no-audit --ignore-scripts @earendil-works/pi-coding-agent; fi

# Chrome DevTools MCP：连接外部 Chrome CDP，供各 agent 统一使用
# 装到镜像自带的 /usr/local，避免老 agent_npm 卷里没有它；后台更新时会装进持久卷并优先使用
RUN if [ "$INSTALL_CDP_MCP" = "true" ]; then npm install -g --no-fund --no-audit chrome-devtools-mcp; fi

# Multica CLI（只装 CLI，不装 self-host 服务端）
RUN if [ "$INSTALL_MULTICA" = "true" ]; then \
      curl -fsSL https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.sh \
      | MULTICA_BIN_DIR=/opt/agents/bin bash; fi

# ===== 管理后台 =====
WORKDIR /opt/agent-hub
COPY admin/package.json admin/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY admin/server.js ./server.js
COPY admin/lib ./lib
COPY admin/public ./public

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace

# 仅作默认端口说明；实际端口由 .env 的 T3_PORT / ADMIN_PORT 决定，host 网络下 EXPOSE 不生效
EXPOSE 3773 3774

ENTRYPOINT ["/entrypoint.sh"]