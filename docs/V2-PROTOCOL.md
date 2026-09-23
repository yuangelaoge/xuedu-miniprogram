# V2 云端协议与接口

**状态更新（2026-09-23）**：协议 2 已随 V2 云函数部署；下文“本地实现、尚未部署”表述反映原编写阶段。实际部署及验证范围见 [V2 部署记录](DEPLOYMENT-2026-09-23-V2.md)。

对应 `miniprogram/domain/v2/protocol.ts`、`server/v2/gateway.ts`、`server/v2/repository.ts` 和 `cloudfunctions/xueduTrial/index.js`。本文件最初描述本地实现，实际部署状态见上方记录。函数名继续为 `xueduTrial`，业务模式为 cloud；demo不调用这些接口。

## 封装、身份与版本

微信调用 `wx.cloud.callFunction({ name: runtime.functionName, data: request })`。函数只从 `cloud.getWXContext()` 获取可信 OPENID/APPID；客户端不能传成员ID冒充操作者或提供角色。入口固定AppID、既有环境和PG配置。所有请求必须 `protocolVersion: 2`，旧版本/旧operation返回 `{ ok:false, code:'UPGRADE_REQUIRED', error:'请更新小程序' }`。

```typescript
interface Request {
  protocolVersion: 2;
  operation: 'bootstrap' | 'initialize' | 'query' | 'command' |
    'photo' | 'photoUrls' | 'clearPreview' | 'clearBegin' | 'clearStep';
  epoch?: string;
  semesterId?: string;
  expectedVersion?: number;
  requestId?: string;
  cursor?: string;
  limit?: number;
  payload?: Record<string, unknown>;
}
interface Response<T> {
  protocolVersion: 2;
  epoch: string;
  resourceVersions: Record<string, number>;
  data: T;
  cursor?: string;
}
```

业务成功为 `{ ok:true, data:Response<T> }`；失败为 `{ ok:false, code, error }`。额外的 `deploymentStatus` 是入口专用的可信身份配置诊断，成功data是固定诊断字段，不属于业务Response，也不读取业务表。它同样要求协议2，不作为客户端启动接口。

- `bootstrap` 用于首次取得轮次；其余查询和业务写入必须携带当前 `epoch`。清空完成返回新轮次，旧缓存/草稿不可继续提交。
- 与学期有关的请求必须顶层携带 `semesterId`，不能依赖组织当前学期。班级/成员/申请/管理员操作与新建学期不属于现有学期资源。
- `expectedVersion` 在**请求顶层**，修改旧对象时必须等于服务端资源version；新建通常传0。它不是业务记录的 `data.revision`，也不是旧workspace的version。具体对象见命令表。
- 修改需 `requestId`；同一逻辑请求重试使用原ID，新操作换ID。服务端按 epoch+可信身份+requestId 独立保存结果。不要把超时视为没有提交，也不要用新ID盲重放。
- `resourceVersions.workspace` 是工作区读版本，其他键为 `resource:id`。服务端事务还核对 permissionsVersion、操作者当前绑定、所有读取/修改对象版本，冲突提示刷新，不覆盖并发结果。
- 写入data返回 `changed` 实体和 `refresh` 资源范围及该命令附加结果，不返回全部历史。`changed`为实体数组，bindings/photos/audit不回传内部内容；按refresh重新请求相关页面。

## 独立资源

每个实体通用字段为 `{ id, epoch, version, data }`，按资源附带 `semesterId/week/memberId/taskId/recordId/parentId/identityKey/studentNo/date/sortKey` 等查询索引。`data`只存单个实体有界字段；大历史集合拆行，图片内容不入库。

| 资源 | 内容/主要关系 |
| --- | --- |
| workspace | autoApproval（有界限时入组设置）、配置、activeSemesterId、epoch、version、permissionsVersion、maintenance、maxExecutionMs |
| members / bindings | 成员与独立微信身份绑定；学号和身份/成员绑定唯一 |
| applications / rebindings | 入组申请与管理员核实的微信换绑申请 |
| classes / semesters / semester_classes | 稳定班级、学期、参与班级独立关联 |
| courses / course_versions | 课程当前资料与生效日期版本 |
| occurrences / exceptions | 日期上课实例及停/调/补课例外 |
| availability / plans / tasks | 学期周无课时间、排班草稿/正式状态、独立任务 |
| records / record_versions | 一任务一记录、历次观察/修改版本及原因/操作者 |
| photos | 私有存储路径、上传者、任务、记录引用 |
| audit / requests / maintenance | 操作审计、幂等结果、固定轮次维护任务 |

`xuedu_v2.cutover_manifest` 是服务端独立切换元数据，不是小程序可查询的业务资源。所有私有表与RPC拒绝普通客户端访问，service_role-only RPC内再核对角色。领域权限由TS网关检查，事务提交再校验身份/权限版本和数据库不变量。

服务端仓储另提供 `count(resource, query)` 聚合计数（`xuedu_v2_count` RPC），清空预览不逐页下载历史记录。`status` 是受白名单限制并带表达式索引的查询字段；停用成员只查询 confirmed/pendingAdjustment/draft 任务，不扫描其已完成历史。上述接口只供可信服务端，不直接暴露给小程序。

## 启动与初始化

`bootstrap` 无payload，返回 `{ workspace, member, application, status, canInitialize, removed, executionConfigured }`。member仅为当前有效成员，申请仅为当前身份；没有全组历史。status为 `needsAdministrator | preparing | ready`；ready表示有启用学期，是否存在课程由课程列表决定，不表示部署验收完成。

`initialize` 需epoch、requestId，payload：

```json
{
  "member": { "name": "本人真实姓名", "studentNo": "本人真实学号" },
  "schoolClass": { "name": "真实班级", "grade": "26", "major": "真实专业" },
  "semester": { "name": "真实学期", "startDate": "2026-09-07", "weeks": 18, "days": 7, "periods": 14, "edition": "" }
}
```

startDate必须星期一；仅服务端指定微信且没有管理员时可执行。一个事务建立真实班级/学期/参与关系/管理员/绑定，设置启用学期。并发仅成功一次；不注入示例。已有管理员但无学期使用 semesterCreate/semesterParticipants/semesterActivate，不再次initialize。入口要求执行上限配置核实一致，见CLOUD-SETUP。

## 查询 `operation: query`

所有查询payload带kind。列表顶层 `limit` 默认50、范围1–100，`cursor` 是上页响应cursor（稳定ID顺序），空字符串表示结束。列表data为 `{ version, items }`；后续页可携带 `payload.version` 锁定首屏版本，变化时要求刷新。不能把单页当作完整名单。未知查询类型拒绝。

| kind | semesterId / payload | 权限与返回 |
| --- | --- | --- |
| semesters | 无 | 已审核成员；分页学期 |
| classes | 无 | 可信微信即可获取申请所需班级标签/资料；分页，不含成员/课表 |
| courses | 必须 | 已审核成员；该学期分页课程 |
| members | 无 | 管理员/部长；分页成员，微信标识不返回 |
| applications | 无 | 管理员/部长；分页入组申请 |
| autoApproval | 无 | 仅管理员；setting、active、expired、version、serverNow；截止时刻按服务端计算 |
| autoApproved | 无 | 仅管理员；分页自动通过申请，包含班级快照、通过时间；不返回微信标识 |
| rebindings | 无 | 仅管理员；分页换绑申请 |
| audit | 无 | 管理员/部长；分页操作记录 |
| records | 必须，week可选 | 成员仅自己，管理人员全组；该学期分页 |
| recordVersions | 必须，id=记录ID | 与原记录同权限；分页版本，不能指定其他记录 |
| semester | 必须 | `{ semester, classIds }`参与班级 |
| task | 必须，id | 本人或管理人员；`{ task }` |
| record | 必须，id | `{ record, canEdit }`；成员仅本人 |
| week | 必须，week | 目标周的semester/plan/draft/uncovered/tasks/plans/availability/records/occurrences；成员任务和记录限本人 |
| report | 必须，week，reportVersion可选 | 管理人员；目标周记录、学期、reportVersion、以及供现有导出器用的仅该周state |
| reportCheck | 必须，version | 管理人员；导出结束前核对版本，返回valid或冲突 |

autoApproval 的 setting 保存 enabled、expiresAt、updatedBy、updatedByName、updatedAt。到期不需要后台任务修改该行，active 始终按服务器时间计算，客户端不可只读 enabled 判断。非管理员 bootstrap 不返回该配置。自动入组 SQL 还用数据库时钟检查截止，并校验成员、绑定、申请与审计四项的关系；到期或冲突全事务回滚。详见 [限时入组说明](AUTO-APPROVAL.md)。

report以记录中的班级/课程快照构造历史统计，不按当前名称反推。report读前后检查工作区版本；生成文件后仍应调用reportCheck再交付，以发现生成过程中修改。该版本保护可因其他业务操作触发保守重做，不拼接两个版本的数据。

## 写命令 `operation: command`

payload必须含type。下表其他字段也在payload，epoch/requestId/semesterId/expectedVersion在顶层。原因一般为非空字符串（最多1000字符）；二次确认是 `confirmed:true`，客户端应先显示对象/影响清单，再发送确认。

| type | payload关键字段 | expectedVersion对应对象 / 权限 |
| --- | --- | --- |
| join | name,studentNo,classId | 首次0；仅被驳回可按本人申请版本重提；限时设置有效则原子建立普通成员，否则待审核；返回 automaticallyApproved |
| autoApprovalSet | enabled；开启须 expiresAt（带时区，严格未来） | workspace.version；仅管理员，保存操作者/时间和前后设置审计 |
| applicationReview | id,approved；驳回需reason | 申请；管理员/部长，通过仅建member |
| roleChange | id,role=`member/leader/admin`,reason,confirmed | 目标成员；管理员，可对自己卸任，保留最后有效管理员 |
| memberStatus | id,active,reason,confirmed | 目标成员；管理员，最后有效管理员不可停用 |
| memberRemove | id,reason | 目标普通成员；管理员/部长；归档，取消未完成任务 |
| memberRestore | id,reason | 已移除普通成员；管理员；复用ID不恢复旧任务 |
| rebindRequest | studentNo,reason | 新请求0；当前微信无绑定；仅申请不认领 |
| rebindConfirm | id,reason,confirmed | 换绑申请；管理员线下核实后执行，删除旧绑定 |
| classSave | id可选,name,grade,major | 旧班级或新建0；管理员，不需课程 |
| classDisable | id,active | 班级；管理员，资料不物理删除 |
| semesterCreate | name,startDate,weeks,days,periods,edition | 新建0；管理员；星期一起始，保存草稿 |
| semesterParticipants | classIds | 顶层semesterId对应学期；管理员；替换参与关系，不删班级 |
| semesterActivate | reason,confirmed（id可选且须匹配semesterId） | 学期；管理员；显式改变全组activeSemesterId |
| import | text=JSON课表文本 | 追加实体的新建语义；管理员，必须semesterId |
| courseSave | id可选,name,teacher,nature,classIds,classroom,weekday,start,end,weeks,expected,effectiveDate | 课程或新建0；管理员，必须semesterId |
| courseDisable | id,effectiveDate | 课程；管理员，必须semesterId，新增停用版本 |
| exceptionSave | courseId,date,kind=`cancel/move/extra`,reason；非cancel可newDate/start/end/classroom | **课程**版本；管理员，必须semesterId |
| availabilitySave | week,slots,optedIn,note | 本人该周无课时间或新建0；有效成员，必须semesterId |
| planGenerate | week | 该周当前confirmed或skipped plan版本；没有则0；管理员/部长 |
| taskAdjust | week,reason,changes | 同上当前正式计划版本；管理员/部长 |
| planConfirm | id=草稿计划ID | 草稿plan版本；管理员/部长 |
| planSkip | week,reason | 当前confirmed或skipped plan版本；没有则0；仅管理员 |
| recordSubmit | taskId,metrics,photos及观察字段 | **任务**版本；任务本人，必须semesterId |
| recordEdit | id=记录ID,reason,metrics,photos及观察字段 | **记录**版本；本人不足24小时或管理员，必须semesterId |

课程维护返回 `impacts`（被标待调整任务），客户端展示清单及自动生成的调整草稿，不自动确认。生效日期必须在学期范围内；参与班级须先加入当期、停用班级不可新建课程。cancel停课、move调日期/节次/教室、extra补课。跨周调整分别生成原周取消和新周补排草稿，新周重新检验可用时间。

JSON导入仍复用现有 `classes/courses` 格式，禁止导入members；单次文本最多300000字符，单批班级+课程最多200条、上课日期最多700个，需分批。保留ID并拒绝重复/非法引用，本轮不支持教务XLSX。

无课时段格式为 `weekday:period`，例如 `1:3`；管理员/部长参与排班需该周 optedIn=true 和完整空闲。taskAdjust的changes每条为 `{ taskId?, memberId?, occurrenceId?, cancel? }`：转派提供原taskId与新memberId，取消提供taskId/cancel:true，补排省略taskId并给成员和实例。一批最多100条。调整先生成draft，planConfirm再检验班级、完整节次、当周一次和已完成任务占用；并发原任务改变则拒绝。

观察字段：`metrics`为expected/actual/late/early/sleep/phone/talk/other，`absentNames/leaveNames/otherDescription/evaluation/feedback/suggestion`为文本，`photos`为1–3个已登记照片ID。修改不能提交memberId/taskId/semesterId/course/date/firstSubmittedAt/createdAt/classes等归属字段。首次提交和各次更正均保存record_versions；后续更正不重开24小时窗口。部长仅能在窗口内改本人记录，不获得他人纠错权限。

## 照片

`photo`：epoch、semesterId、requestId，payload `{ taskId, base64 }`。不接受任意目标路径；服务器检查任务归属/管理员纠错资格、期限与约500KB限制，写入固定 `cloud/<epoch>/<随机ID>.jpg` 私有路径并登记，返回 `photoId`（`fileID`为同一业务ID兼容字段）。随后recordSubmit/Edit引用此ID；不能跨记录引用照片。上传成功而登记失败可能留下该轮次孤儿文件，维护扫描固定轮次目录处理。

`photoUrls`：epoch、semesterId，payload `{ recordId, versionId? }` 获取当前/历史版本照片；也支持 `{ ids:[业务照片ID] }`（最多30），逐张检查归属。未提交照片仅上传者可读取；已提交照片遵循原记录权限。只返回短时签名URL，历史照片继续保留到统一业务清空。

## 统一业务清空

全部仅有效管理员，epoch必须匹配，必须有有效管理员及全部管理员真实班级；执行时长配置须匹配。

1. `clearPreview` 无payload：返回administrators、retainedClasses、deletedClasses、members、semesters、courses、records、photos、version、jobId；只预览不冻结。
2. `clearBegin`：expectedVersion为预览workspace版本，requestId；payload.confirmation必须精确“清空业务数据，保留管理员及其班级”。冻结并登记维护任务，返回jobId/done/waitMs。
3. `clearStep`：requestId，payload.jobId。根据waitMs等待后用新的步骤ID继续；不并行推动同一任务。服务端持久租约、固定oldEpoch/路径、每批删除、失败冻结可续跑；完成返回done和新epoch。重复的同一逻辑请求可安全重放结果。

保留所有管理员（含inactive）及其绑定、班级完整资料，原状态不变；其余业务资源与照片清空，仅保留最少当前任务/完成审计。旧确认文字无效；没有resetAll或businessClearBegin兼容别名。旧任务迟到不能扫新轮次；执行上限变更需按维护恢复安排处理，不直接修改租约规避。

## 限制、错误和实际验证

移除旧约650KB整个工作区限制，但保留单次请求约1200000字符、单实体有界字段、提交变更/读取数量、照片/导入限制。SQL与TS均有版本/唯一约束；服务端SDK错误只回固定公开文案。常见code包括UPGRADE_REQUIRED、UNAUTHENTICATED、FORBIDDEN、CONFIGURATION、VERSION_CONFLICT、EPOCH_CHANGED/EPOCH_CONFLICT、MAINTENANCE、LAST_ADMIN、EDIT_WINDOW_CLOSED、CUTOVER_REQUIRED；客户端以error提示，不把失败当成功。

本地领域、入口、分页容量、离线切换及PG集成已有阶段验证；最终完整运行结果见本轮交付。线上迁移/照片/真机/跨设备尚未在本轮执行。服务端prepare/open迁移接口和敏感离线材料严格不在小程序operation白名单，详见 [V2-CUTOVER.md](V2-CUTOVER.md)。

`planSkip` 生成 `data.skip=true` 的取消草稿，原任务继续生效；须再调用 `planConfirm` 才取消未完成任务并将计划设为 `skipped`。创建草稿及确认时均检查本周无已提交记录；已有记录只能调整剩余任务，不能整周跳过。`week.plan` 和报表包含 skipped 状态，导出显示跳过原因。跳过后可用 `planGenerate` 或 `taskAdjust`（expectedVersion 为 skipped 计划版本）重新生成草稿，人工确认后恢复 confirmed。
