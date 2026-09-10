# 部署指南 — Cloudflare Workers + D1

本文档面向把 `worker/` 部署到 Cloudflare 生产环境的完整流程，包括本地开发、
D1 建库与迁移、正式部署、自定义域名、灰度/回滚、垃圾回收与常见问题排查。

> 快速开始见 [README.md](./README.md)；本文件是更详细的生产部署说明。

---

## 1. 前置条件

| 项目 | 要求 |
| --- | --- |
| Node.js | 18 及以上（建议 20+；本仓库验证于 Node 24） |
| 包管理器 | npm（仓库使用 `package.json` + `npx wrangler`） |
| Cloudflare 账号 | 需要有 Workers 与 D1 权限 |
| 认证方式 | 本地用 `wrangler login`；CI 用 API Token |
| 兼容标志 | 已在 `wrangler.toml` 配置 `nodejs_compat`（zstd 依赖 `node:zlib`） |

依赖安装（会拉取 `wrangler`）：

```sh
cd worker
npm install
```

---

## 2. 架构概览（部署前需了解）

```
浏览器 / curl
   │
   ▼
Cloudflare Worker  (worker/src/index.js)
   ├── 静态资源  public/favicon.ico  → Workers Static Assets 直接返回
   ├── 笔记路由  /:note, /:note/:mode → Worker fetch 处理
   └── D1 绑定   env.DB              → notes 表（zstd 压缩后的 BLOB）
             ▲
Cron Trigger └─ 每天 03:00 UTC 调用 scheduled 清理过期行
```

- **一个 Worker + 一个 D1 数据库 + 一个 Cron Trigger**，无其他依赖。
- 笔记正文以 **zstd** 压缩后写入 D1 的 `content`（BLOB），`content_encoding` 记录编码。
- 表结构含 `created_at` / `updated_at` / `expires_at`，以及预留的密码列
  （`is_protected` / `password_hash` / `password_salt` / `password_algo`）。
- 应用假定部署在**站点根路径**（重定向与 favicon 使用 `/<id>`、`/favicon.ico`）。

---

## 3. 登录 Cloudflare

```sh
# 本地交互式登录（会打开浏览器）
npx wrangler login

# 确认身份
npx wrangler whoami
```

CI / 无浏览器环境改用 API Token（见第 8 节）。

---

## 4. 创建 D1 数据库

```sh
npx wrangler d1 create minimalist-web-notepad
```

命令会输出数据库信息，例如：

```
[[d1_databases]]
binding = "DB"
database_name = "minimalist-web-notepad"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

把 `database_id` 填入 `worker/wrangler.toml`，替换占位符
`REPLACE_WITH_YOUR_DATABASE_ID`。

可选参数：

- `--location apac` — 指定主位置提示，取值
  `weur` / `eeur` / `apac` / `oc` / `wnam` / `enam`。
- `--jurisdiction eu|fedramp|us` — 数据驻留限制（设置了则忽略 location）。
- `--update-config` — 自动把绑定写入 wrangler 配置，免手改。

> 注意：D1 数据库**只能创建在远程**，本地开发用的是 Miniflare 模拟的本地库，
> 两者相互独立。

---

## 5. 本地开发

```sh
cd worker

# 1) 在本地库上应用表结构（生成 .wrangler/state 下的本地 SQLite）
npx wrangler d1 migrations apply minimalist-web-notepad --local

# 2) 启动本地 dev server（默认 http://127.0.0.1:8787）
npm run dev
```

本地验证清单：

```sh
# 根路径应 302 到随机 5 位 ID
curl -s -D - -o /dev/null http://127.0.0.1:8787/

# CLI 写入 + 读取（curl UA 自动返回原文）
echo hello | curl --data-binary @- http://127.0.0.1:8787/cli-test
curl http://127.0.0.1:8787/cli-test            # hello

# 输出模式
curl http://127.0.0.1:8787/cli-test/plain
curl http://127.0.0.1:8787/cli-test/base64     # aGVsbG8=
curl http://127.0.0.1:8787/cli-test/md5        # 5d41402abc4b2a76b9719d911017c592

# 追加
echo " world" | curl --data-binary @- http://127.0.0.1:8787/cli-test/append
curl http://127.0.0.1:8787/cli-test            # hello world
```

查看本地库内容：

```sh
npx wrangler d1 execute minimalist-web-notepad --local \
  --command "SELECT id, content_encoding, size_raw, size_stored, expires_at FROM notes"
```

本地状态保存在 `worker/.wrangler/`（已在 `.gitignore` 中忽略）。

---

## 6. 应用生产表结构

**部署代码之前**先把 schema 应用到远程库：

```sh
npx wrangler d1 migrations apply minimalist-web-notepad --remote
```

- 迁移文件位于 `worker/migrations/`，按文件名顺序执行，已应用的会跳过。
- 首次执行会创建 `notes` 表与 `idx_notes_expires_at` 索引。
- 该命令会打印将要执行的迁移；交互终端下可能请求确认，CI/非交互环境会直接执行。

> 代码与数据兼容：新增字段或改变默认编码时，读取端仍能解析旧行
> （当前 `decompress` 同时支持 `zstd` / `gzip` / `identity`），因此无需回填。

---

## 7. 部署

```sh
cd worker
npm run deploy        # 等价于 npx wrangler deploy
```

部署成功后会输出 Worker 的 URL：

- 默认：`https://minimalist-web-notepad.<你的子域>.workers.dev`
- 建议部署后立即用第 9 节清单做一次冒烟测试。

部署包含：

- `src/index.js` 打包上传；
- `public/` 作为静态资源（favicon）；
- `[[d1_databases]]` 绑定 `env.DB`；
- `[triggers]` 注册 Cron；
- `[vars]` 注入 `NOTE_TTL_DAYS`。

查看实时日志：

```sh
npx wrangler tail
```

---

## 8. CI / 非交互部署

设置环境变量后即可在流水线中部署：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 具有 Workers Scripts:Edit、D1:Edit 权限的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID（Dashboard 右侧可查） |

```sh
cd worker
npm ci
npx wrangler d1 migrations apply minimalist-web-notepad --remote
npx wrangler deploy
```

如需密钥（例如将来启用密码功能时），用 `wrangler secret`：

```sh
npx wrangler secret put SOME_SECRET
```

---

## 9. 部署后验证清单

```sh
BASE=https://<你的-worker-域名>

# 1. 根路径重定向
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$BASE/"

# 2. 写入 / 读取 / 模式
echo hello | curl --data-binary @- "$BASE/smoke"
curl "$BASE/smoke"          # hello
curl "$BASE/smoke/plain"    # hello
curl "$BASE/smoke/base64"   # aGVsbG8=
curl "$BASE/smoke/md5"      # 5d41402abc4b2a76b9719d911017c592
curl -s -o /dev/null -w '%{content_type}\n' "$BASE/smoke/json"   # application/json

# 3. 表单保存（模拟网页自动保存）
curl -s -d 'text=from+form' "$BASE/smoke"
curl "$BASE/smoke"          # from form

# 4. 表单空值删除
curl -s -d 'text=' "$BASE/smoke"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/smoke/plain"     # 302 -> /smoke

# 5. 静态资源
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/favicon.ico"     # 200

# 6. 确认库内编码为 zstd、有过期时间
npx wrangler d1 execute minimalist-web-notepad --remote \
  --command "SELECT id, content_encoding, size_raw, size_stored, expires_at FROM notes LIMIT 5"
```

浏览器侧：打开首页应重定向到随机 ID，输入内容约 1 秒后自动保存，刷新后仍在。

---

## 10. 配置项

全部集中在 `worker/wrangler.toml`：

| 配置 | 位置 | 说明 |
| --- | --- | --- |
| `NOTE_TTL_DAYS` | `[vars]` | 笔记有效期（天），默认 `30`；设为 `0` 表示永不过期 |
| `crons` | `[triggers]` | GC 频率，默认 `["0 3 * * *"]`（每天 03:00 UTC） |
| `compatibility_flags` | 顶层 | 需保留 `nodejs_compat`（zstd 依赖 `node:zlib`） |
| `compatibility_date` | 顶层 | 需 ≥ `2024-09-23` 才能启用 `nodejs_compat` v2 |
| `database_id` | `[[d1_databases]]` | 第 4 步创建后填入 |

修改后重新 `npm run deploy` 生效。注意：修改 `crons` 后需部署一次，
Cloudflare 才会更新触发器。

### 垃圾回收

- 自动：Cron Trigger 每天调用 `scheduled`，删除 `expires_at < now` 的行。
- 手动：`npm run db:gc`（对远程库执行一次 DELETE）。
- 惰性：读取到已过期行时，Worker 用 `ctx.waitUntil` 立即删除并当作不存在。

### 过期策略说明

每次写入都会刷新 `expires_at = now + NOTE_TTL_DAYS`，即“闲置即过期”。
若希望“创建后固定过期”，可在迁移中调整或修改 `saveNote` 逻辑。

---

## 11. 自定义域名 / 路由

Dashboard → Workers & Pages → 选择 `minimalist-web-notepad` → Settings →
Domains & Routes，添加自定义域名。也可在 `wrangler.toml` 声明：

```toml
routes = [
  { pattern = "notes.example.com", custom_domain = true },
]
```

应用使用根路径（`/<id>`、`/favicon.ico`），因此建议绑定**独立子域**，而不是
挂在某个网站的二级目录下；若必须放在子路径，需要反代重写路径或用
`<base href>` 方案。

---

## 12. 灰度与回滚

```sh
# 查看历史部署
npx wrangler deployments list

# 查看当前状态
npx wrangler deployments status

# 回滚到上一个版本
npx wrangler rollback --message "revert bad deploy"
```

重要：**回滚只回滚 Worker 代码，不会回滚 D1 数据。** 由于读取端兼容
`zstd` / `gzip` / `identity`，代码在不同编码版本间回滚是安全的；但删除数据的
操作不可逆，回滚前请确认。

---

## 13. 常见问题排查

**`database_id` 仍是占位符 / binding 报错**
未替换 `wrangler.toml` 里的 `REPLACE_WITH_YOUR_DATABASE_ID`。执行
`npx wrangler d1 list` 找到真实 ID 后填入。

**本地能跑、线上报 no such table: notes**
远程库还没应用迁移。运行
`npx wrangler d1 migrations apply minimalist-web-notepad --remote`。

**`zstdCompressSync is not a function`**
缺少 `nodejs_compat` 兼容标志，或 `compatibility_date` 过旧。确认
`wrangler.toml` 含 `compatibility_flags = ["nodejs_compat"]` 且日期
≥ `2024-09-23`，然后重新部署。

**zstd / node:zlib 相关的构建或体积告警**
`nodejs_compat` 会注入 polyfill，bundle 略增大；本 Worker 约 15 KiB
（gzip 后约 5 KiB），可忽略。

**`wrangler dev` 无法启动 / workerd 下载失败**
多为网络/代理问题。确认能访问 `*.workers.dev` 与 npm registry；必要时
配置代理后重试，或升级 wrangler。

**迁移显示 “No migrations to apply!” 但表不存在**
可能用了 `--local` 而目标是远程（或反之）。本地用 `--local`，线上用
`--remote`，两者数据独立。

**Cron 没有触发 GC**
确认已部署且 `[triggers] crons` 非空；在 Dashboard 的 Worker → Triggers
可查看。也可先手动 `npm run db:gc` 验证 SQL。

**大文本或高并发下的限制**
Workers 有 CPU 时间上限、D1 有单库容量与查询限制。当前实现使用同步 zstd，
超大笔记会占用 CPU；如遇到可改为异步/流式压缩，或对超长内容降级为
`identity` 存储。

**favicon 404**
确认 `worker/public/favicon.ico` 存在且 `wrangler.toml` 的 `[assets]` 指向
`./public`；静态资源与 Worker 路由共存时，未匹配到文件才会进入 Worker。

---

## 14. 安全与合规

- 所有响应带 `Cache-Control: no-store` 与 `X-Robots-Tag: noindex, nofollow`。
- 原 PHP 版的 Apache Basic Auth 在 Workers 上不适用；如需访问控制，可用
  Cloudflare Access 或 Worker 内的鉴权逻辑。
- 密码查看功能尚未启用，但表结构已预留 `password_*` 字段；后续建议用
  PBKDF2（`crypto.subtle`）存哈希，并结合 `is_protected` 控制读取。
- 笔记 ID 为 5 位随机字符（约 1700 万组合），与上游一致，**不是**强访问控制，
  敏感内容请勿依赖 ID 保密性。
