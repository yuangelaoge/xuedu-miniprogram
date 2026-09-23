# V2 数据与接口约定

使用 miniprogram/domain/v2/protocol.ts 为共享传输协议。每个资源独立表，一行一个实体；data JSONB 仅存该实体的有界字段（如一条记录的观察数据），历史版本、照片、任务和关联均独立行，不存无限增长集合。

server/v2/repository.ts：workspace/query/get/commit。query 默认50最多100，以稳定ID游标翻页，提供semesterId/week/memberId等索引筛选。仅服务端RPC允许访问私有schema；调用者微信身份来自云入口。

commit：事务锁定工作区轮次/维护状态/权限版本，校验操作者绑定及读版本，写实体预期版本（新建0），最后检查至少一有效管理员及身份/学号/任务记录唯一。权限相关变化增加permissionsVersion，所有提交增加workspace.version。并发写不盲重试，回显刷新冲突。请求唯一为(epoch, identityKey, requestId)，结果可重放。

领域业务 server/v2/gateway.ts 暴露 createGatewayV2({repository, appid, bootstrapOpenid, now, uuid, photos, maxExecutionMs})。photos接口 upload(path,base64), urls(ids), list(prefix,limit), delete(ids)。旧云接口不接入。API operation 使用 bootstrap, initialize, query, command, photo, photoUrls, clearPreview, clearBegin, clearStep。

query payload.kind：semesters/classes/courses/members/applications/rebindings/audit/records/record/recordVersions/week/report；分页 cursor/limit；week/report 提供 payload.week；record/recordVersions 提供 payload.id。所有学期读写请求顶层semesterId。
command payload.type：classSave, classDisable, semesterCreate, semesterParticipants, semesterActivate, courseSave, courseDisable, exceptionSave, join, applicationReview, roleChange, memberRemove, memberRestore, rebindRequest, rebindConfirm, availabilitySave, planGenerate, planConfirm, taskAdjust, recordSubmit, recordEdit。其余字段放payload；修改对象id/expectedVersion在payload可读，顶层expectedVersion为主要修改对象。写入返回changed对象或refresh列表，不返回全量状态。

bootstrap 返回 workspace, member(无则null), status(needsAdministrator|preparing|ready), canInitialize，成员无需拉取历史。所有响应包装 protocolVersion/epoch/resourceVersions/data/cursor。查询不可泄露其他微信标识。

维护任务存固定oldEpoch与其照片目录，在轮次内冻结旧写入；删除仅固定目录，完成转换新epoch且保留管理员及绑定班级。 maxExecutionMs 必须在入口服务端提供并校验（禁止客户端设置）；租约与排空时间由其推导。

客户端cloud服务保存启动状态和账号/环境viewSemesterId，逐页/按周查询；demo沿用原本地引擎。页面不调用全量snapshot。
