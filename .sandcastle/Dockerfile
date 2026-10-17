# edgeone-agent-lab 沙箱镜像 —— 由 sandcastle-factory 模板 Dockerfile.skeleton 适配而来
# 栈：Node 22 + TypeScript type-stripping；门禁 npm test + npm run typecheck
FROM node:22-bookworm

# ① 代理 build-args（本机 Clash 后面构建时用；CI 留空）
ARG HTTPS_PROXY=""
ARG HTTP_PROXY=""
ARG NO_PROXY=""

# ② 系统依赖 + GitHub CLI（工单口）
RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl jq ca-certificates unzip \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# ③ UID/GID 对齐：node base 自带 node 用户 → ③b 模式（groupmod/usermod 改名 agent）
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# ⑤ OpenCode CLI v2 —— Node base 走 npm 安装路径（@opencode/cli 是 2.x 包名；
#    1.x 的 opencode-ai 停在 1.19.3，不认识 opencode-go provider）
RUN npm install -g @opencode/cli \
  && opencode --version

# ⑥ 显式 provider 配置：容器内 Bun fetch 不走代理、models.dev 拉不到
#    （只剩内置模型 → provider.no-route）；--chown 防 EACCES
COPY --chown=${AGENT_UID}:${AGENT_GID} .sandcastle/opencode.json /home/agent/.config/opencode/opencode.json

USER ${AGENT_UID}:${AGENT_GID}

# ⑦ 挂载点预建（docker 会把 bind-mount 目标建成 root 所有）
RUN mkdir -p /home/agent/.npm /home/agent/.cache \
  && chown -R ${AGENT_UID}:${AGENT_GID} /home/agent/.npm /home/agent/.cache

WORKDIR /home/agent

# worktree 沙箱模式：sandcastle 把 git worktree bind-mount 到 ${SANDBOX_REPO_DIR}
ENTRYPOINT ["sleep", "infinity"]
