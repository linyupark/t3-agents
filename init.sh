#!/bin/bash
# 初始化脚本：在宿主机上运行，准备配置目录
# 用法: ./init.sh

set -e

# 相对路径和 Compose 一样，按项目目录解析
cd "$(dirname "$0")"

echo "=== 初始化 T3 Code Agent Hub ==="

# .env
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "[✓] 已从 .env.example 创建 .env"
fi

# 只读取需要的键，避免 source 执行 .env 里的任意内容。
# 后出现的键覆盖先出现的，和 Compose 的行为一致。
env_get() {
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env \
    | tail -n 1 \
    | sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' \
          -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" \
    | tr -d '\r'
}

# 优先级和 Compose 一致：shell 环境 > .env > 默认值
WORKSPACE_DIR=${WORKSPACE_DIR:-$(env_get WORKSPACE_DIR)}
WORKSPACE_DIR=${WORKSPACE_DIR:-./workspace}
CONFIG_DIR=${CONFIG_DIR:-$(env_get CONFIG_DIR)}
CONFIG_DIR=${CONFIG_DIR:-./config}
T3_PORT=${T3_PORT:-$(env_get T3_PORT)}
T3_PORT=${T3_PORT:-3773}
T3_BIND=${T3_BIND:-$(env_get T3_BIND)}
T3_BIND=${T3_BIND:-0.0.0.0}
ADMIN_PORT=${ADMIN_PORT:-$(env_get ADMIN_PORT)}
ADMIN_PORT=${ADMIN_PORT:-3774}
ADMIN_BIND=${ADMIN_BIND:-$(env_get ADMIN_BIND)}
ADMIN_BIND=${ADMIN_BIND:-0.0.0.0}

if [ -z "$WORKSPACE_DIR" ] || [ -z "$CONFIG_DIR" ]; then
  echo "[x] WORKSPACE_DIR 和 CONFIG_DIR 不能为空" >&2
  exit 1
fi

echo "[i] 工作区: $WORKSPACE_DIR"
echo "[i] 配置目录: $CONFIG_DIR"

mkdir -p \
  "$CONFIG_DIR"/codex "$CONFIG_DIR"/claude "$CONFIG_DIR"/opencode \
  "$CONFIG_DIR"/pi "$CONFIG_DIR"/gemini "$CONFIG_DIR"/t3 \
  "$CONFIG_DIR"/multica "$CONFIG_DIR"/admin "$CONFIG_DIR"/logs \
  "$CONFIG_DIR"/ssh "$CONFIG_DIR"/git "$CONFIG_DIR"/cache "$CONFIG_DIR"/npm \
  "$CONFIG_DIR"/claude/skills "$CONFIG_DIR"/codex/skills \
  "$CONFIG_DIR"/opencode/skills "$CONFIG_DIR"/pi/agent/skills \
  "$WORKSPACE_DIR/.tmp/var-tmp" \
  "$WORKSPACE_DIR/.agents/skills" \
  "$WORKSPACE_DIR/.multica-workspaces"

# /tmp、/var/tmp 直接使用这两个目录，需要 world-writable + sticky
chmod 1777 "$WORKSPACE_DIR/.tmp" "$WORKSPACE_DIR/.tmp/var-tmp"
chmod 755 "$WORKSPACE_DIR/.agents" "$WORKSPACE_DIR/.agents/skills"

# Compose 挂载的是 CONFIG_DIR/git 目录，gitconfig 只是目录里的文件。
# 老部署可能已经被 Docker 建成了目录，这里尝试恢复；需要重启容器才会重新挂载。
if [ -d "$CONFIG_DIR/git/gitconfig" ]; then
  if rmdir "$CONFIG_DIR/git/gitconfig" 2>/dev/null; then
    echo "[!] $CONFIG_DIR/git/gitconfig 曾是空目录（Docker 自动创建），已重建为文件；请重启容器让挂载生效"
  else
    echo "[x] $CONFIG_DIR/git/gitconfig 是非空目录，请手动备份并删除后再运行" >&2
  fi
fi
[ -d "$CONFIG_DIR/git/gitconfig" ] || { [ -f "$CONFIG_DIR/git/gitconfig" ] || : > "$CONFIG_DIR/git/gitconfig"; }
chmod 600 "$CONFIG_DIR/git/gitconfig" 2>/dev/null || true

# Claude Code 2.x 使用 CLAUDE_CONFIG_DIR，全局状态落在 CONFIG_DIR/claude/.claude.json。
# 旧布局是 CONFIG_DIR/claude.json（文件级 bind mount），这里做一次性迁移。
if [ -s "$CONFIG_DIR/claude.json" ] && [ ! -s "$CONFIG_DIR/claude/.claude.json" ]; then
  cp "$CONFIG_DIR/claude.json" "$CONFIG_DIR/claude/.claude.json"
  echo "[✓] 已迁移 $CONFIG_DIR/claude.json -> $CONFIG_DIR/claude/.claude.json"
fi
[ -s "$CONFIG_DIR/claude/.claude.json" ] || printf '{}\n' > "$CONFIG_DIR/claude/.claude.json"
chmod 600 "$CONFIG_DIR/claude/.claude.json"

# 管理后台令牌
if ! grep -qE '^ADMIN_TOKEN=.+' .env 2>/dev/null; then
  if command -v openssl >/dev/null 2>&1; then
    TOKEN=$(openssl rand -hex 16)
  else
    TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
  fi
  if grep -q '^ADMIN_TOKEN=' .env 2>/dev/null; then
    sed -i "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=${TOKEN}|" .env
  else
    printf '\nADMIN_TOKEN=%s\n' "${TOKEN}" >> .env
  fi
  echo "[✓] 已生成管理后台令牌（见 .env 的 ADMIN_TOKEN）"
fi

chmod 700 "$CONFIG_DIR/admin" 2>/dev/null || true

# 技能目录：
#   共享技能（所有 agent）  WORKSPACE_DIR/.agents/skills
#   Claude 专有             CONFIG_DIR/claude/skills
#   Codex 专有              CONFIG_DIR/codex/skills
#   OpenCode 专有           CONFIG_DIR/opencode/skills
#   Pi 专有                 CONFIG_DIR/pi/agent/skills
# 各 agent 原生就支持“共享目录 + 自己的目录”，这里不再把专有技能合并进共享目录。

# Git 全局配置
if [ -f ~/.gitconfig ] && [ ! -s "$CONFIG_DIR/git/gitconfig" ]; then
  cp ~/.gitconfig "$CONFIG_DIR/git/gitconfig"
  echo "[✓] 已复制 Git 全局配置"
fi

# SSH 密钥
for f in id_ed25519 id_ed25519.pub id_rsa id_rsa.pub known_hosts; do
  if [ -f ~/.ssh/$f ] && [ ! -f "$CONFIG_DIR/ssh/$f" ]; then
    cp ~/.ssh/$f "$CONFIG_DIR/ssh/"
    echo "[✓] 已复制 $f"
  fi
done

# Codex 配置
for f in config.toml models.json auth.json; do
  if [ -f ~/.codex/$f ] && [ ! -f "$CONFIG_DIR/codex/$f" ]; then
    cp ~/.codex/$f "$CONFIG_DIR/codex/"
    echo "[✓] 已复制 Codex $f"
  fi
done

# 在容器内 Codex 需要关闭自身沙箱（由 Docker 隔离）
if [ -f "$CONFIG_DIR/codex/config.toml" ]; then
  if ! grep -q "danger-full-access" "$CONFIG_DIR/codex/config.toml"; then
    cat >> "$CONFIG_DIR/codex/config.toml" <<'EOF'

# Docker 容器内禁用 Codex 自身沙箱（由容器边界保证隔离）
sandbox_mode = "danger-full-access"
approval_policy = "never"
EOF
    echo "[✓] 已为容器环境追加 Codex 沙箱配置"
  fi
fi

# Claude Code 配置
for f in settings.json credentials.json; do
  if [ -f ~/.claude/$f ] && [ ! -f "$CONFIG_DIR/claude/$f" ]; then
    cp ~/.claude/$f "$CONFIG_DIR/claude/"
    echo "[✓] 已复制 Claude Code $f"
  fi
done

echo ""
echo "=== 初始化完成 ==="
echo "启动: docker compose up -d --build"
echo ""
echo "访问:"
echo "  T3 Code:  http://localhost:${T3_PORT}  (监听 ${T3_BIND}:${T3_PORT})"
echo "  管理后台: http://localhost:${ADMIN_PORT}  (监听 ${ADMIN_BIND}:${ADMIN_PORT})"
echo "  用户名随意，密码为 .env 中的 ADMIN_TOKEN"
echo ""
echo "注意: network_mode: host，端口就是宿主机实际监听端口，没有 ports: 映射。"
