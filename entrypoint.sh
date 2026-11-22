#!/bin/bash
# 所有前台进程由 Node supervisor 管理；这里只做目录和权限准备。
set -u

echo "=== T3 Code Agent Hub 启动 ==="

mkdir -p \
  /root/.codex /root/.claude /root/.config/opencode /root/.pi/agent \
  /root/.gemini /root/.t3 /root/.multica /root/.agent-hub \
  /root/.local/bin /var/log/agent-hub \
  /root/.agents /workspace/.agents/skills \
  /workspace/.tmp /workspace/.tmp/var-tmp \
  /workspace/.multica-workspaces \
  "${DATA_DIR:-/root/.agent-hub}"

# /tmp 和 /var/tmp 挂在 workspace 下，保持临时目录语义
chmod 1777 /tmp /var/tmp 2>/dev/null || true

# CLAUDE_CONFIG_DIR=/root/.claude：全局状态在持久化目录内，避免文件级挂载导致原子写入失败
# 如果是从旧布局升级，容器里可能还残留 /root/.claude.json，复制过来
if [ -s /root/.claude.json ] && [ ! -s /root/.claude/.claude.json ]; then
  cp /root/.claude.json /root/.claude/.claude.json
fi
[ -s /root/.claude/.claude.json ] || printf '{}\n' > /root/.claude/.claude.json
chmod 600 /root/.claude/.claude.json 2>/dev/null || true

# 已有配置目录的权限修正（.ssh 必须是 700）
if [ -d /root/.ssh ]; then
  chmod 700 /root/.ssh 2>/dev/null || true
  find /root/.ssh -maxdepth 1 -type f -exec chmod 600 {} \; 2>/dev/null || true
fi
chmod 700 /root/.agent-hub 2>/dev/null || true

# T3 的配对码、Multica 的登录态都依赖稳定的 HOME；这里固定为 root
export HOME=/root

exec node /opt/agent-hub/server.js