# T3 Code Agent Hub

T3 Code 控制面 + 多 agent CLI + Multica runtime，单容器部署，附带一个轻量管理后台。

## 快速开始

```bash
./init.sh
# 可选：编辑 .env 改 WORKSPACE_DIR / CONFIG_DIR / 端口，然后重跑一次
# ./init.sh
docker compose up -d --build
```

访问（默认端口，改 `.env` 后以 `.env` 为准）：

- T3 Code: `http://localhost:3773`
- 管理后台: `http://localhost:3774`（Basic Auth，用户名随意，密码是 `.env` 里的 `ADMIN_TOKEN`）

## 配置（.env）

`./init.sh` 会在 `.env` 不存在时从 `.env.example` 复制一份。Compose 用 `.env` 做 `${VAR}` 插值，所以改完要执行 `docker compose up -d` 重建容器；`docker compose restart` 不会应用新的挂载和端口。改过 `WORKSPACE_DIR` / `CONFIG_DIR` 后还要重跑一次 `./init.sh`，让新目录和权限先就位，避免 Docker 以 root 自动创建；只改端口不用重跑。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WORKSPACE_DIR` | `./workspace` | 宿主机工作区路径，挂到容器内 `/workspace`。建议用绝对路径并放在项目目录外，避免进入 Docker build context |
| `CONFIG_DIR` | `./config` | 宿主机配置/缓存/日志根目录，容器内路径不变 |
| `T3_PORT` | `3773` | T3 在宿主机上的监听端口 |
| `T3_BIND` | `0.0.0.0` | T3 监听地址；只允许本机访问可改 `127.0.0.1` |
| `ADMIN_PORT` | `3774` | 管理后台监听端口 |
| `ADMIN_BIND` | `0.0.0.0` | 管理后台监听地址；只在本机反代可改 `127.0.0.1` |
| `CDP_URL` | `http://127.0.0.1:16002` | 首次启动写入各 agent 的默认 CDP 地址；后台保存过设置后以 `settings.json` 为准 |
| `SHM_SIZE` | `1g` | 容器 `/dev/shm` 大小；Chrome 渲染大页面崩溃时调大 |
| `MEM_LIMIT` | `6g` | 容器内存上限（同时作用于 `mem_limit` 和 `memswap_limit`） |
| `ADMIN_TOKEN` | 空 | 管理后台 Basic Auth 密码；留空时 `init.sh` 自动生成 |
| `AUTOSTART_MULTICA` | `1` | 容器启动时是否自动恢复 Multica 并拉起 daemon |

关于端口：容器使用 `network_mode: host`，Compose 里没有 `ports:` 映射。`T3_PORT`、`ADMIN_PORT` 写多少，宿主机就监听多少；如果和宿主机已有服务冲突，容器会启动失败，换一个空闲端口即可。`CDP_URL` 里的 `16002` 也是宿主机端口，不是映射出来的。

关于目录：`WORKSPACE_DIR`、`CONFIG_DIR` 只影响宿主机侧挂载，容器内仍然是 `/workspace`、`/root/.codex` 等固定路径。换目录不会自动搬迁旧数据，需要先把原来的 `workspace/`、`config/` 内容拷到新位置；建议先 `docker compose down` 再操作。自定义目录如果放在项目内，记得同时加入 `.gitignore` 和 `.dockerignore`，避免被提交或进入 Docker build context。

## 这次改了什么

### 1. 容器重建不再重装 agent

原来的 `entrypoint.sh` 每次启动都会执行更新循环，但版本检查有 bug：

```bash
local_name="${pkg##*@}"   # @anthropic-ai/claude-code -> claude-code
npm ls -g "claude-code"   # 永远查不到，于是每次都重装
```

同时 `npm install -g` 写进的是容器可写层，`docker compose down` 后必然丢失。

现在：

- 所有 npm 全局包装进 `/opt/agents`，compose 用命名卷 `agent_npm` 持久化；
- 已移除 Antigravity（`agy`）；`/root/.local` 保留为命名卷 `agent_local`，供 pipx/uv 等 user-level 工具使用；
- Claude Code 设置 `CLAUDE_CONFIG_DIR=/root/.claude`，全局状态文件落在 `CONFIG_DIR/claude/.claude.json`（默认 `config/claude/.claude.json`）。旧布局的 `config/claude.json` 会在 `init.sh` 里自动迁移；这样也避免了文件级 bind mount 与 Claude 的原子写入冲突。**已有部署升级后请先重跑一次 `./init.sh` 再重建**；
- Git 全局配置改为挂载目录 `${CONFIG_DIR:-./config}/git:/root/.config/git`（默认 `./config/git`），`GIT_CONFIG_GLOBAL` 指向其中的 `gitconfig`，不再直接挂载单个文件，Docker 不会再把源建成目录；镜像里的 `/etc/gitconfig` 设置了 `safe.directory = *`，避免 workspace 宿主 uid 与容器 root 不一致导致 git 拒绝操作。老部署如果默认的 `config/git/gitconfig` 已被建成空目录，`init.sh` 会尝试恢复，修复后需要重启容器；
- 删除了启动时的自动更新循环。升级在管理后台点按钮，写入的是持久卷。

首次 `docker compose up --build` 会从镜像初始化这两个卷；之后 `down` / `up` 不会重装。

> 需要 Docker Compose ≥ 2.24（`env_file` 的 `required: false` 语法）。如果改了安装开关、想从镜像重新灌一次包，执行 `docker compose down -v` 再 `up --build`；`-v` 只删这两个命名卷，`CONFIG_DIR`、`WORKSPACE_DIR` 是 bind mount，不受影响。

### 2. root 下 Claude Code 报 bypassPermissions

容器本身已经是隔离边界，按官方提示设置：

```yaml
environment:
  - IS_SANDBOX=1
```

如果以后想改成非 root 运行，需要同时改 `HOME`、所有 `/root/...` 挂载点和卷权限，不能只加 `USER`。

### 3. 管理后台（Hono，无构建步骤）

没有用 Next.js：这个后台只有表单、命令执行和日志轮询，Next 的构建链和运行时会明显增加镜像体积与启动时间。现在用的是 `hono` + `@hono/node-server` + 原生 HTML/JS，单进程、无打包。

功能：

- **T3 配对码**：按钮执行 `t3 pair`，解析配对链接并生成二维码；
- **Agent 版本**：列出已安装/最新版本，逐个更新；
- **浏览器 / CDP**：给所有 agent 统一配置外部 Chrome CDP，测试连接，安装/更新 `chrome-devtools-mcp`；
- **第三方模型**：一份配置分配给多个 agent，自动生成各自配置文件；
- **Multica**：保存 server_url/app_url/token，登录、启停 daemon、看日志；
- **日志**：T3 / Multica / 管理后台三个来源。

后台和 T3 在同一个容器里：`entrypoint.sh` 只做目录准备，然后交给 `node server.js` 作为 supervisor，由它拉起 `t3 serve` 和 `multica daemon start --foreground`。

### 4. 第三方模型配置

管理后台里的“模型配置”会写入：

| Agent | 文件 | 说明 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / 模型 |
| Codex | `~/.codex/config.toml` | 自定义 provider，`wire_api = "responses"` |
| OpenCode | `~/.config/opencode/opencode.json` | `providers.agenthub` |
| Pi | `~/.pi/agent/models.json` + `settings.json` | `agenthub` provider + 默认模型 |

注意：

- **Claude Code 只能接 Anthropic 兼容端点**；
- **Codex 目前只支持 OpenAI Responses**（`wire_api = "responses"`），Chat Completions-only 的网关无法给 Codex 用；
- Codex 的 key 通过环境变量 `AGENT_HUB_CODEX_KEY` 注入，所以新增、换 key 或**取消** Codex 分配时，后台都会重启 T3（以及正在运行的 Multica daemon），避免残留旧 key；
- 给 Claude/Codex 分配了协议不兼容的配置时，会打警告并清掉后台之前写入的配置，不会继续沿用旧端点；
- 删除某个 agent 的分配后，后台会移除自己写入的 provider 配置。

### 5. Multica

镜像构建时安装 CLI 到 `/opt/agents/bin`。管理后台把配置保存在 `CONFIG_DIR/admin/settings.json`（0600，默认 `./config/admin/settings.json`），登录态在 `CONFIG_DIR/multica`。

容器启动时如果存在 `server_url`，会自动执行：

```bash
multica config set server_url ...
multica config set app_url ...
multica auth status   # 已登录则跳过
multica login --token=...
multica daemon start --foreground
```

工作目录通过 `MULTICA_WORKSPACES_ROOT=/workspace/.multica-workspaces` 放在持久化的 workspace 目录里。`MULTICA_DAEMON_AUTO_UPDATE=0` 避免 daemon 自行升级造成行为漂移。

> 你在对话里贴出的 `mul_...` token 已经泄露，建议在 Multica 里吊销并重新生成一个，只填进管理后台。

### 6. 临时文件、缓存与共享 Skills

容易撑大容器可写层的目录都落到了宿主机（下表按默认 `WORKSPACE_DIR=./workspace`、`CONFIG_DIR=./config`；改过变量后前缀相应替换）：

| 容器路径 | 宿主机路径 | 用途 |
|---|---|---|
| `/tmp` | `WORKSPACE_DIR/.tmp` | agent 临时文件 |
| `/var/tmp` | `WORKSPACE_DIR/.tmp/var-tmp` | 长周期临时文件 |
| `/root/.cache` | `CONFIG_DIR/cache` | pip / uv / playwright / go-build 等缓存 |
| `/root/.npm` | `CONFIG_DIR/npm` | npm 缓存 |
| `/root/.local` | 命名卷 `agent_local` | pipx / uv 等 user-level 安装 |

`/tmp` 映射后不会随容器重建自动清空，需要定期处理（只删普通文件，不碰目录和 socket）：

```bash
sudo find "${WORKSPACE_DIR:-./workspace}/.tmp" -type f -mtime +7 -delete
```

全局技能目录：

```text
${WORKSPACE_DIR:-./workspace}/.agents/skills/<skill-name>/SKILL.md
```

- Codex、OpenCode、Pi 原生读取 `~/.agents/skills`，compose 已把 `WORKSPACE_DIR/.agents` 挂到 `/root/.agents`；
- Claude Code 只读 `~/.claude/skills`，compose 把同一个 `skills` 目录单独挂了进去；
- 新增技能后重启对应 agent 会话即可生效（Pi 可在会话里 `/reload`）。

技能使用通用的 Agent Skills 格式：

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

具体操作步骤……
```

同名技能不会合并：OpenCode 按优先级覆盖，Pi 保留先发现的，建议目录名和 frontmatter 的 `name` 保持一致。如果 `WORKSPACE_DIR` 本身是 git 仓库，建议把 `.agents/`、`.tmp/` 加进它的 `.gitignore`。

`init.sh` 会把 `CONFIG_DIR/claude/skills`、`CONFIG_DIR/opencode/skills`、`CONFIG_DIR/pi/agent/skills` 里已有的技能**复制**到共享目录（不删除原文件）；确认共享目录里的版本可用后，可以自行清掉各原生目录里的旧副本。

### 7. 浏览器 / CDP

管理后台新增“浏览器 / CDP”卡片：把同一个 Chrome CDP 地址（默认取 `.env` 的 `CDP_URL`，未设置时为 `http://127.0.0.1:16002`）写入所有 agent 的 MCP 配置，使用的是 `chrome-devtools-mcp`。容器是 `network_mode: host`，容器里的 `127.0.0.1:16002` 就是宿主机（或其他 host-network 容器）的 CDP 端口。`CDP_URL` 只作为首次启动的默认值；在后台保存过设置后，以 `CONFIG_DIR/admin/settings.json` 里的 `browser.cdpUrl` 为准。

| Agent | 写入位置 | 形式 |
|---|---|---|
| Claude Code | `~/.claude/.claude.json` | 顶层 `mcpServers.agenthub-cdp` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.agenthub-cdp]` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp.servers.agenthub-cdp` |
| Pi | `~/.pi/agent/mcp.json` | `mcpServers.agenthub-cdp` |

统一使用的命令等价于：

```bash
chrome-devtools-mcp --browser-url=http://127.0.0.1:16002
```

注意：

- 首次打开后台时默认启用；不需要就把“启用并写入所有 agent”取消再保存，后台会移除自己写入的 `agenthub-cdp` 条目，不会动其他 MCP。
- `chrome-devtools-mcp` 随镜像装在 `/usr/local`，老 `agent_npm` 卷里没有它也能直接用；在后台点“安装/更新 MCP”会装进持久卷 `/opt/agents`，之后优先使用卷里的版本（`down -v` 后回落到镜像版本）。
- 保存后对**新会话**生效。T3 里已经打开的线程可能缓存了 MCP 列表，必要时重启 T3 或开新线程。
- 多个 agent 同时操作同一个浏览器会互相抢 tab；并发跑浏览器任务时建议让它们开独立 tab，或错开执行。
- CDP 端口等同于浏览器控制权（包括已登录站点），只监听 `127.0.0.1`，不要暴露到公网。后台本身也不要直接暴露到公网。

T3 自己的预览浏览器：

- T3 的预览浏览器固定使用它自己下载到 `~/.t3/tools/chrome-headless-shell` 的 headless Chrome，通过 `--remote-debugging-pipe` 控制，**不支持改接外部 CDP**（源码里没有这个选项）。所以这里的两件事要分开看：外部 CDP 是给 agent 用的额外工具；T3 预览用的是它自己的浏览器。
- 在 root 容器里，Chrome sandbox 无法启动，compose 已设置 `T3CODE_SERVER_BROWSER_SANDBOX=0`（T3 官方支持的方式），并加了 `shm_size`（默认 `1g`，可用 `.env` 的 `SHM_SIZE` 调大）。
- 镜像已预装 T3 `browser setup` 对应的 Chrome 运行库和字体（`libnss3`、`libgbm1`、`fontconfig`、`fonts-liberation` 等）。如果 T3 预览仍报缺库，先看 `CONFIG_DIR/logs/t3.log` 的具体报错；容器内 `t3 browser setup` 只会再检查和安装系统包，不会解决 root sandbox 限制。
- T3 内的 agent 还可以使用 T3 注入的 `preview_*` MCP 工具操作内置浏览器；外部 CDP MCP 是另一套工具，二者可以同时存在。



## 目录

```
.
├── Dockerfile
├── docker-compose.yml
├── .env.example           # 配置模板；init.sh 会复制为 .env
├── entrypoint.sh          # 目录准备 -> exec node server.js
├── init.sh                # 宿主机初始化
├── AGENTS.md              # 接手开发的 agent 必读
├── CLAUDE.md              # 指向 AGENTS.md
├── admin/
│   ├── server.js          # Hono 后台 + 进程 supervisor
│   ├── lib/
│   │   ├── agents.js      # 版本查询 / npm 更新
│   │   ├── browser.js     # CDP 探测 / MCP 配置写入
│   │   ├── models.js      # 各 agent 配置文件生成
│   │   ├── multica.js     # Multica CLI 封装
│   │   ├── procs.js       # 子进程 + 环形日志
│   │   ├── store.js       # 设置持久化 / token
│   │   └── t3.js          # t3 pair
│   └── public/index.html  # 单页 UI（无构建）
├── config/                # CONFIG_DIR 默认值，运行时生成，已 gitignore
│   ├── claude/
│   │   └── .claude.json   # Claude 全局状态（CLAUDE_CONFIG_DIR）
│   ├── git/
│   │   └── gitconfig      # git 全局配置（GIT_CONFIG_GLOBAL）
│   ├── cache/             # ~/.cache
│   ├── npm/               # ~/.npm
│   └── ...
└── workspace/             # WORKSPACE_DIR 默认值，agent 工作区
    ├── .agents/skills/    # 全局共享技能
    └── .tmp/              # /tmp、/var/tmp 映射
```

## 安全提示

- 管理后台能执行固定命令、改 agent 配置，等于高权限入口。`ADMIN_TOKEN` 用长随机串，不要直接暴露到公网；建议放在 Tailscale / 反代 + HTTPS 后面。
- `network_mode: host` 下默认 `T3_BIND=0.0.0.0`、`ADMIN_BIND=0.0.0.0`，会监听所有网卡。只想本机访问就把这两个改成 `127.0.0.1`；需要手机局域网配 T3 时，`T3_BIND` 保持 `0.0.0.0`。
- `T3_PORT`、`ADMIN_PORT` 是宿主机实际监听端口，不是容器映射；注意不要和宿主机已有服务冲突。
- CDP 端口（默认 `16002`，由 `CDP_URL` 指定）等于浏览器控制权，能看到/操作已登录的站点。只让它监听 `127.0.0.1`，不要暴露到局域网或公网。
- 镜像内 `/etc/gitconfig` 设置了 `safe.directory = *`，让容器内 root 能操作 bind mount 的宿主仓库。这是单用户容器的便利设置，不要把不受信任的仓库挂进来。
- 后台不使用宿主机的 `docker.sock`，避免把 Docker 控制权交给 agent。
- 容器内是 root + `IS_SANDBOX=1`，隔离边界来自容器本身；不要把不可信代码和宿主机敏感目录一起挂进来。

## 常用命令

```bash
# 重建镜像
docker compose up -d --build

# 只重启容器（不会重装 agent）
docker compose down && docker compose up -d

# 查看日志（路径按默认 CONFIG_DIR=./config）
docker logs -f t3code
tail -f config/logs/t3.log config/logs/multica.log config/logs/admin.log
```
