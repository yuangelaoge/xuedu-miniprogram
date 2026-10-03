# 开发版 1.1.4 · 信息部干事全组记录与完整 Excel

2026-10-03 按开发任务用户“授权你直接让推送的对话开始推送”要求完成发布。功能提交 `762836d`，发布源码 main 合并提交 `5344082e95575fce572298bc86990b3daa7170df`，推送后本地 HEAD、origin/main 与远端 main 一致。保留既有发布记录和用户 AGENTS.md、考评资料；后两者不提交，未取其他工作区旧修改。用户要求查看的模拟 Excel 由开发任务另行交付，不作为发布审批关卡。

## 发布范围与目标

- 信息部干事可读全组记录、历史版本、已提交签字照片；完整 Excel 使用与管理员一致的 exportXlsx，包含原始数据、统计、公式、原生图表和相同空周行为。
- 干事仍不能 TXT/复制名单、确认草稿、任务调整、成员管理或改他人记录；具体无课时段仅本人可读。组部长收权保持。全组记录独立分页，默认50、最多100；普通 week 接口仍为干事本人范围。
- 私有 GitHub 仓库 `yuangelaoge/xuedu-miniprogram` 的 main 已推送上述源码。AppID `wx5c7d4a458873c686`，cloud runtime、环境 `xuedu-trial-d2gs2dpnla9206eb3`、函数 `xueduTrial` 保持。
- 微信开发版 **1.1.4**，官方 CLI `✔ upload`，包大小 **1,532,930 字节**。回执 `artifacts/upload/1.1.4-5344082-result.json` 与补充元数据 `artifacts/upload/1.1.4-release-note.json` 留本地，不入库。
- 备注沿用“学督小程序第二次测试，主要修改：新增信息部干事角色；修复了一些已知问题”。内部包版本仍 1.0.0，界面版本仍 v1.0。

## 008 迁移与后端

仅应用 `server/migrations/008-officer-record-access.sql`，没有重放006/007。版本 `20261003150000`，名称 `officer_record_access`，任务 `task-269db320` 在 `2026-10-03 23:38:31 +08:00` 确认为 Succeed，远端迁移历史已记录。

迁移只替换 `public.xuedu_v2_bootstrap_page(text,jsonb,boolean)`，放开 records 页面干事阅读，不新增表结构或修改业务行。线上函数体与本地脚本 MD5 均 `ef705812f62e3a23ec2d2fbab9dfe501`。迁移后 SECURITY DEFINER、search_path=pg_catalog 保持，anon/authenticated 执行权限为 false，service_role 为 true。

迁移前原定义已保存到仓库外 `/Users/david/.codex/recovery/xuedu-20261003-officer-records/before-008.sql`，目录700、文件600。该文件只含接口定义与权限恢复语句，不是数据备份。

既有 `xueduTrial` 官方 CLI 部署成功，8文件、77.6 KB，平台修改时间 `2026-10-03 23:39:04`，Active。Nodejs20.19、index.main、3秒超时及全部环境变量值前后相同，保留服务端 Key、BOOTSTRAP_OPENID、PostgreSQL模式与审核配置。代码由上述源码提交构建；未下载云端包逐字节比对。

## 验证与实际限制

- 本次重新执行类型检查、200项常规测试、18个WXML编译、V2构建、官方wcc异步角色渲染，均通过；20项独立数据库条件测试在常规套件跳过。
- 一次性本地PostgreSQL17重新应用003–008，10项page RPC/适配测试通过，容器已删除。跨页56/57条、权限撤销、本人无课过滤、干事与管理员Excel字节一致、有数据/空周/图表及照片读取权限由隔离测试覆盖。
- 部署后可信微信上下文真实调用 deploymentStatus 配置正确，bootstrap ready/admin/single-rpc；submissionStatus、summaryReport、excelReport、namesReport、xlsx reportCheck均成功且版本一致；schedule/records/profile/courses/availability五页快速读取均成功。
- 本次真实调用使用管理员身份，不代替真实干事账号验收；未分配或修改真实角色。签名URL桩、审核示意图不等于实际照片上传和受控读取端到端验收；未在手机独立读回包来源或完整Excel。完整照片流程、双微信、多设备、真实并发、完整一周业务和备份恢复仍未全面验收。

没有修改业务行、分配角色、清理资料、设置体验版、提交审核、正式发布或改变套餐。45041服务端口按用户要求保持开放，结束已验证监听，未改其他安全设置。

## 分层回退

- Git可追溯上一发布基线 `da97dd84b9c696b48b7c4f9cd7f0922edec23fea`，通过新的回退提交保留历史。
- 前端需按确认过的基线重建并上传新的开发版；旧上传记录不是一键回退。
- 云函数与008读取接口须一起核对。原接口定义已保存，回退须另行授权，以新的恢复迁移和匹配源码重建部署，核对当前007/008结构兼容及迁移历史。不能只重放006或只恢复旧前端；回退将取消干事全组明细/照片与完整Excel新范围。目前无经过完整验证的独立云端回退包。
- 接口定义备份不能恢复业务数据；代码回退不等于数据恢复，完整备份恢复尚未验收，不承诺无损恢复。
