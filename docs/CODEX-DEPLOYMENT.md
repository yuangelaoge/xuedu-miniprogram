# Codex 云开发接入与部署交接

## 接入状态（2026-09-22）

已通过 Codex CLI 添加腾讯官方市场 `tencent-cloudbase`，安装 `cloudbase@tencent-cloudbase` 0.2.0，核对插件包含 Skills 和 CloudBase MCP 启动配置。本次运行中的任务尚未加载出 CloudBase 工具，需新开任务或重新加载插件后继续登录及只读验证。未验证账号授权、环境读取和日志读取；未部署代码、修改云配置或写入业务数据。

## 范围

Codex 负责代码、构建和调用部署工具；CloudBase 插件负责云端管理能力；微信开发者工具及其 CLI 负责小程序预览、上传和真实微信调用验证。安装插件不等于已登录、已部署或已通过联调。

官方接入：https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/ide-setup/codex

插件市场来源 `TencentCloudBase/CloudBase-MCP`，Git 引用 `main`，插件 `cloudbase`。安装后须验证新任务实际加载 MCP 和 Skills，再按工具提供的登录流程授权。不要重复安装全局 MCP 与插件中的同一服务。

## 项目定位

- 项目根目录：`/Users/david/Desktop/学督APP`，不是单个函数根目录。
- 试用环境：`xuedu-trial-d2gs2dpnla9206eb3`。
- 试用函数：`xueduTrial`；已记录运行时 Nodejs20.19，入口 `index.main`。部署前读取云端配置复核。
- 数据库：PostgreSQL，保留既有 RLS、角色校验及私有照片桶；不要套用旧文档数据库集合初始化步骤。
- 源码：`server/` 及 `cloudfunctions/xueduTrial/index.js`；构建脚本 `scripts/build-cloud.mjs`。
- 试用部署目录：`cloudfunctions/xueduTrial/`；`generated/` 是构建产物，不作为功能修改源头。
- 正式函数构建输出 `cloudfunctions/xueduProduction/` 不代表允许部署正式环境。

## 首次连接验证

1. 确认插件工具加载；完成账号登录。部署登录与函数内 service_role Key 是不同用途，不互相替代。
2. 只读列出环境，核对上述环境 ID 和函数名。
3. 读取函数状态及配置，验证日志读取能力。凭据值、OpenID 和日志中的个人数据不写入交接记录或仓库。
4. 分别记录“安装成功、工具加载、登录成功、环境读取、函数读取、日志读取”，不能用其中一项推定其他项通过。

## 后端部署流程

1. 核对工作区改动与要发布的代码版本，不混入其他并行任务未交付的修改。先检查类型及测试，再运行 `npm run build:cloud`。
2. 读取现有函数配置，保留 `XUEDU_STORAGE=postgresql`、服务端 API Key 绑定、`BOOTSTRAP_OPENID` 等已有配置；不输出其秘密值。
3. 优先使用明确只更新代码的操作。不能未经核对使用会覆盖配置或触发器的强制部署选项。
4. 仅部署试用函数；SQL 迁移单独核对、执行和记录，不把代码上传当作迁移完成。
5. 通过微信小程序可信上下文验证身份与快照；一般工具直接调用成功不能替代微信身份验收。照片、业务写入和跨设备同步分别验收。
6. 记录时间、提交版本（若存在未提交发布需明确）、目标环境与函数、配置变更、迁移编号、验证结果和可用的回退版本。

## 前端上传流程

确认 `miniprogram/config/runtime.ts` 的模式、环境和函数名；通过微信开发者工具编译、预览和验证后，按授权上传开发版。上传开发版、提交审核、正式发布是不同动作。后端部署不会自动上传小程序。

若为微信工具 CLI 临时开启服务端口，完成后恢复关闭并验证，不修改其他安全设置。

## 多任务协作

功能开发交付代码、必要测试和迁移脚本；部署任务统一执行发布；运维任务先只读定位。对同一云环境的部署、迁移、数据修复串行执行。数据修复需明确范围、备份及恢复方式，遵守聚合状态 revision/CAS 机制。

下载到 Downloads 的单函数 AGENTS.md 仅作参考，不覆盖项目根 AGENTS.md；业务规则和最新验收事实以本项目交接及实际验证为准。
