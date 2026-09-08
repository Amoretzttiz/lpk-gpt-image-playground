# GPT Image Playground · LazyCat 定制版

这是 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) 的下游定制分支，用于构建 LazyCat 应用包。上游源码采用 MIT License；本仓库保留原作者声明与许可证。

- **上游基线**：`v0.7.8`
- **下游应用版本**：`0.7.9`（不是上游发布版本）
- **LazyCat 包版本**：`0.7.9-5`
- **公开仓库**：<https://github.com/Amoretzttiz/lpk-gpt-image-playground>

## 主要差异

- 保留上游 React 19、Vite、TypeScript、Zustand 前端及图片生成、编辑、Agent 对话和浏览器画廊能力。
- 增加同源**持久化 HTTP API**，在 LazyCat 私有应用数据目录中保存浏览器同步快照，并通过跨进程文件锁合并并发写入。
- 保留独立的实验性 CAS、版本化元数据、幂等操作和范围读取 API；当前前端仍使用兼容快照 API，尚未迁移到 CAS 数据模型。
- LazyCat 默认 API 地址是公开的 `https://api.openai.com/v1`，代理默认关闭且不锁定。用户可通过环境变量改为自己的兼容服务。

持久化服务是普通 HTTP API，**不是 MCP 服务**，也不提供模型工具协议接口。

## 架构

```text
浏览器前端（IndexedDB）
  ├─ 直接调用用户配置的图片 API
  └─ /api/persistence  ──> Node.js 持久化服务
                             ├─ state.json（兼容快照）
                             ├─ backups/*.json（脱敏恢复副本）
                             └─ v0.8/{cas,metadata.json}（实验性 CAS/元数据 API）
```

Nginx 提供静态前端、可选 `/api-proxy/` 转发和 `/api/persistence` 同源路由。修改请求需要同源检查、会话 Cookie 和 CSRF token。服务端原子写入文件，并依赖 Linux `/usr/bin/flock` 完成跨进程互斥。持久化后端只应位于 LazyCat 可信网关与 Nginx 后方，不能作为自带认证的独立公网服务暴露。

## 本地开发与测试

要求 Node.js 24、npm，以及运行持久化服务时可用的 `/usr/bin/flock`。

```bash
npm ci
npm test
npm run build
```

开发服务器：`npm run dev`。

独立启动持久化 API：

```bash
PERSISTENCE_DIR="$PWD/runtime" \
BACKUP_DIR="$PWD/runtime/backups" \
npm run start:persistence
```

默认前端通过同源 `/api/persistence` 访问服务。写请求会先访问 `/api/persistence/session` 建立 Cookie 会话并取得 CSRF token。非 LazyCat 环境可在构建时设置 `VITE_PERSISTENCE_URL`，但服务仍要求浏览器同源访问，因此通常应自行配置反向代理。持久化不可用时，前端继续使用浏览器 IndexedDB 离线工作。

## LazyCat 打包

```bash
lzc-cli project lint
lzc-cli project release
lzc-cli lpk lint dist-lpk/cloud.lazycat.app.gpt-image-playground-v0.7.9-5.lpk
```

`lzc-cli project release` 会执行 `lzc-build.yml`：安装锁定依赖、构建前端、复制运行时脚本并生成 `.lpk`。生成目录 `dist/`、`dist-lpk/`、`lazycat/content/web/` 和 `lazycat/content/persistence/` 不进入版本库。

LazyCat 标识保持为：

- 包 ID：`cloud.lazycat.app.gpt-image-playground`
- 子域名：`gpt-image-playground`
- 私有数据：`/lzcapp/var/gpt-image-playground`
- 脱敏恢复副本：`/lzcapp/var/gpt-image-playground/backups`

## 配置

默认不携带 API Key。常用运行变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEFAULT_API_URL` | `https://api.openai.com/v1` | 前端初始 API 地址 |
| `API_PROXY_URL` | `https://api.openai.com/v1` | 启用同源代理后的上游地址 |
| `ENABLE_API_PROXY` | `false` | 是否启用 `/api-proxy/` |
| `LOCK_API_PROXY` | `false` | 是否强制锁定代理设置 |
| `PERSISTENCE_DIR` | `/lzcapp/var/gpt-image-playground` | 私有持久化目录 |
| `BACKUP_DIR` | `/lzcapp/var/gpt-image-playground/backups` | 服务端脱敏恢复副本目录 |

也可以在应用自身的导出功能中下载 ZIP/JSON，由每位用户自行保存到个人文档目录；仓库不预置任何用户名或个人文档路径。

## 安全与备份

- 不要把 `.env`、API Key、访问令牌、运行时数据库或个人备份提交到仓库。
- API 配置和生成记录会进入私有 `state.json`；服务端 `backups/*.json` 仅按敏感字段名脱敏，可能无法覆盖任意自由文本中的秘密，也不是可直接还原的完整灾备副本。两者都不能替代对 `/lzcapp/var` 的访问控制。
- API 代理会让应用服务器代发请求。只在可信网络和适当访问控制下启用，并明确配置自己的上游地址。
- 更新前备份 `/lzcapp/var/gpt-image-playground`；应用内导出属于可选的每用户备份方式。
- 当前 CAS/元数据 API 有独立测试，但前端未接入；不要删除 `state.json`，也不要把 CAS 目录当作完整快照备份。
- 当前快照同步按实体 ID 追加或覆盖；缺失实体不会被解释为删除，因此多端删除不会收敛。未发生新的前端状态变化时，也不会额外定时推送。

## 上游与许可

核心界面和大部分功能来自 [GPT Image Playground](https://github.com/CookSleep/gpt_image_playground)。下游修改包括 LazyCat 打包、持久化兼容层、安全加固与公开默认配置。详见 [LICENSE](LICENSE) 和 [RELEASE.md](RELEASE.md)。
