# 2.0.0 上传记录（2026-10-24）

按用户要求，将同一份 1.4.7 代码重新以 **2.0.0** 上传微信开发版，功能没有新增修改；未提交审核或正式发布，未部署后端、迁移或修改线上数据。

业务源码仍为 `bcff0d9aa8c68904ebb88a02404eb6ffd6fa4848`，复用隔离目录 `artifacts/upload/1.4.7/project/`。上传前重新验证根工作区和隔离目录的源码、构建均与 `artifacts/release-check/2026-10-23T15-44-21-406Z-8591/manifest.json` 一致；复用该清单中 302 项普通测试及 63 项 PostgreSQL 测试全部通过的结果，没有重复执行测试或声称新增真机验收。

用户完成原生确认后，上传任务 `confirmation_upload_eec037cd-7e7f-4b62-a973-b5c41d37cd44` 返回 `status=success`、`execution_success`、`result.success=true`。包大小 1,613,463 字节，与 1.4.7 相同；版本号来自本次上传参数，结果回执未独立回显版本。证据保存在忽略目录 `artifacts/release-2.0.0/`。

累计功能及验证边界见 [1.4.6 发布记录](RELEASE-1.4.6.md) 与 [1.4.7 上传记录](RELEASE-1.4.7.md)，旧记录保留其实际上传版本。
