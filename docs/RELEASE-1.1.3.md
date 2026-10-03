# 开发版 1.1.3 · 提交状态按钮布局

2026-10-03 按用户“改好直接推送”要求，完成私有 GitHub main 推送及微信开发版上传。仅修改 `miniprogram/app.scss`、`miniprogram/templates/cloud.wxml`，功能提交 `64ed4925277dcebae575be3fbe9af0c1709571b1`，发布源码 main 合并提交 `ff2e601df4a56bbef083379fa3b000a40efa981a`。推送后本地 HEAD、origin/main 与远端 main 一致。保留原发布记录、用户 AGENTS.md 修改和考评文件，后两者未提交。

听课安排、听课记录共用“查看第 x 周提交状态”按钮采用专用类：宽度 100%、flex 双向居中、最小高度 84rpx、margin 0、padding 20rpx 24rpx。文案、交互和权限未变。

## 上传与验证

- AppID `wx5c7d4a458873c686`，cloud runtime 仍指向 `xuedu-trial-d2gs2dpnla9206eb3`、`xueduTrial`。项目/函数内部版本 1.0.0 及界面 v1.0 未改。
- 微信开发版 **1.1.3**，官方 CLI `✔ upload`，包大小 **1,532,668 字节**。回执为 `artifacts/upload/1.1.3-ff2e601-result.json`，补充元数据为 `artifacts/upload/1.1.3-release-note.json`，不入库。
- 备注沿用“学督小程序第二次测试，主要修改：新增信息部干事角色；修复了一些已知问题”。
- 18 个 WXML 编译、已有异步角色渲染检查和 diff check 通过。官方微信开发工具重新编译后，两个真实页面按钮均读取到 display:flex、align-items:center、justify-content:center、text-align:center、左右 margin:0px、border-box；当前模拟器宽度均为 307px、高度 40px、left=29px。检查只读页面布局，未点击提交状态或修改业务。验证后回到首页。布局证据留在本机 `/tmp/xuedu-113-layout-result.json`。
- 此次为两文件样式修改，未重复运行业务测试或云函数构建；先前 1.1.2 的业务验证作为历史基线，不计为本轮新运行。

## 未执行及回退

没有重新部署云函数、执行 SQL/迁移、修改线上业务数据、设置体验版、提交审核或正式发布；后端仍为 1.1.2 已部署版本。没有独立验证手机包来源和真机布局；完整照片流程、双微信、多设备、真实并发、一周业务与备份恢复仍未全面验收。

45041 服务端口按用户要求保持开放，结束已验证监听，未改其他安全设置。

源码可通过新的回退提交恢复上一发布基线 `2967ae506c44345c0721c2a0cdedbb018c7b69b6`，重建并上传新的开发版；旧上传记录不是一键回退。本次前端回退无需改变后端或数据。若另需云函数回退，必须重新核对目标提交与当前迁移/数据结构兼容性，现无完整验证的独立云端回退包。代码回退不等于数据恢复，备份恢复尚未验收。
