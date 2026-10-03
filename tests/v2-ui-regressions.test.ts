import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerCloudPage} from '../miniprogram/services/v2/page';
import {runtime} from '../miniprogram/config/runtime';
import {createGatewayV2} from '../server/v2/gateway';
import {MemoryRepository} from '../server/v2/memory';
import {Entity,Workspace} from '../miniprogram/domain/v2/protocol';
import {boundedWeek} from '../miniprogram/domain/calendar';
import {Semester} from '../miniprogram/domain/types';
const event=(dataset:any={},value:any='')=>({currentTarget:{dataset},detail:{value}});
let sequence=0;
async function fixture(work:(f:any)=>Promise<void>,activeSemesterId='semester') {
 const g=globalThis as any,oldWx=g.wx,oldPage=g.Page,oldRuntime={...runtime};runtime.mode='cloud';runtime.env='ui-regression-'+ ++sequence;
 const e=(id:string,data:any,extra:any={}):Entity=>({id,epoch:'ui',version:1,data,...extra});
 const workspace:Workspace={id:'main',epoch:'ui',version:1,permissionsVersion:1,protocolVersion:2,activeSemesterId,maintenance:'',maxExecutionMs:3000};
 const semester={name:'合成秋季',startDate:'2026-09-07',weeks:20,days:5,periods:14,status:'active',edition:'合成组织'};
 const course={id:'course',name:'合成数学',classIds:['c'],classroom:'101',start:1,end:2,weekday:1,weeks:[1],expected:20};
 const repo=new MemoryRepository(workspace,{members:[e('admin',{name:'合成管理员',studentNo:'001',role:'admin',classId:'c',active:true},{studentNo:'001'}),e('member',{name:'合成成员',studentNo:'002',role:'member',classId:'c',active:true},{studentNo:'002'})],bindings:[e('ba',{},{identityKey:'owner',memberId:'admin'}),e('bm',{},{identityKey:'member',memberId:'member'})],classes:[e('c',{name:'合成班',grade:'26',major:'合成专业',active:true})],semester_classes:[e('sc',{},{semesterId:'semester',parentId:'c'})],semesters:[e('semester',semester),e('historical',{...semester,name:'历史合成学期',startDate:'2025-09-01',status:'draft'})],
 applications:Array.from({length:55},(_,i)=>e('app-'+String(i).padStart(3,'0'),{name:'申请'+i,studentNo:'A'+i,classId:'c',classLabel:'合成班',status:i===1||i===52?'pending':'rejected'},{identityKey:'applicant'+i,studentNo:'A'+i})),
 availability:[e('previous',{slots:['1:1','1:2'],note:'上一周备注',optedIn:true},{semesterId:'semester',memberId:'admin',week:1})],
 tasks:[e('task',{status:'submitted',memberName:'合成成员',classLabel:'合成班',course,date:'2026-09-07'},{semesterId:'semester',week:1,memberId:'member'}),e('pending',{status:'pendingAdjustment',memberName:'待调整成员',classLabel:'合成班',course,date:'2026-09-07'},{semesterId:'semester',week:1,memberId:'admin'}),e('cancelled',{status:'cancelled',memberName:'不应显示'},{semesterId:'semester',week:1,memberId:'member'})],
 plans:[e('plan',{status:'confirmed',uncovered:[{label:'未覆盖班',reason:'无可用成员'}]},{semesterId:'semester',week:1}),e('skipped-week',{status:'skipped',reason:'假期'},{semesterId:'semester',week:2})],
 records:[e('record',{memberName:'合成成员',classLabel:'合成班',classes:[{id:'c',name:'合成班',grade:'26',major:'合成专业'}],course,date:'2026-09-07',firstSubmittedAt:'2026-09-07T00:00:00Z',metrics:{expected:20,actual:20,late:0,early:0,sleep:0,phone:0,talk:0,other:0},absentNames:'无',leaveNames:'无',photos:[],revision:1},{semesterId:'semester',week:1,memberId:'member',taskId:'task'})]});
 let who='owner',pageDefinition:any,confirm=true,mutateOnWrite=false,failAvailabilitySave=false,exitAlert=false;const calls:any[]=[],errors:string[]=[],copied:string[]=[],written:any[]=[],opened:any[]=[],navigation:any[]=[],modals:any[]=[],scrolls:any[]=[];
 const gateway=createGatewayV2({repository:repo,appid:'app',bootstrapOpenid:'owner',maxExecutionMs:3000,now:()=>Date.parse('2026-09-23T00:00:00Z'),uuid:()=>`generated-${++sequence}`,photos:{async upload(){return '';},async urls(){return [];},async list(){return [];},async delete(){}}});
 const storage=new Map();g.Page=(p:any)=>pageDefinition=p;
 g.wx={env:{USER_DATA_PATH:'/synthetic'},getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:any)=>storage.set(k,v),removeStorageSync:(k:string)=>storage.delete(k),showToast(){},enableAlertBeforeUnload(){exitAlert=true;},disableAlertBeforeUnload(){exitAlert=false;},pageScrollTo(o:any){scrolls.push(o);},async showModal(o:any){modals.push(o);if(o.showCancel===false){errors.push(o.content);return {confirm:false};}return {confirm,content:'核对'};},async setClipboardData({data}:any){copied.push(data);},openDocument(o:any){opened.push(o);},navigateTo(o:any){navigation.push(o.url);},getFileSystemManager(){return {writeFile(o:any){written.push(o);if(mutateOnWrite){const original=repo.workspace.bind(repo);repo.workspace=async()=>({...await original(),version:2});}o.success();o.complete();}};},cloud:{init(){},async callFunction({data}:any){calls.push(data);if(failAvailabilitySave && data.payload?.type==='availabilitySave')return {result:{ok:false,error:'合成保存失败'}};try{return {result:{ok:true,data:await gateway(data,{OPENID:who,APPID:'app'})}};}catch(e){return {result:{ok:false,error:(e as Error).message}};}}}};
 const pages:any[]=[];const page=async(view:any,q:any={week:'1'})=>{registerCloudPage(view);const p={...pageDefinition,data:structuredClone(pageDefinition.data),setData(v:any,callback?:()=>void){Object.assign(this.data,v);callback?.();}};pages.push(p);p.onLoad(q);await p.load();assert.equal(p.data.error,'');return p;};
 try{await work({page,repo,calls,errors,copied,written,opened,navigation,modals,scrolls,exitAlert:()=>exitAlert,failAvailabilitySave:()=>failAvailabilitySave=true,semester,who:(v:string)=>who=v,confirm:(v:boolean)=>confirm=v,mutateOnWrite:()=>mutateOnWrite=true});}finally{pages.forEach(p=>p.onUnload());g.wx=oldWx;g.Page=oldPage;Object.assign(runtime,oldRuntime);}
}
test('V2前端：待审核提示用准确计数，搜索与全选不跨已加载范围',async()=>fixture(async f=>{
 const profile=await f.page('profile');assert.equal(profile.data.pendingLabel,'2 待审核');assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.page.view,'profile');
 profile.navigate(event({target:'manage',section:'applications'}));assert.match(f.navigation[0],/section=applications/);
 const manage=await f.page('manage',{section:'applications'});assert.equal(manage.data.rows.length,50);assert.equal(manage.data.visibleRows.length,1);await manage.more();assert.equal(manage.data.rows.length,55);assert.equal(manage.data.visibleRows.length,2);
 manage.search(event({},'申请52'));manage.selectAllApplications();assert.deepEqual(manage.data.selectedApplications,['app-052']);assert.equal(manage.data.visibleRows[0].selected,true);
 f.who('member');await profile.load();assert.equal(profile.data.pendingLabel,'');assert.equal(profile.data.pendingCount,0);
}));
test('V2前端：复制最新名单及保存后打开，导出前后核验版本且不重复执行',async()=>fixture(async f=>{
 const page=await f.page('records');await page.copyReport();assert.equal(f.copied.length,1);assert.match(f.copied[0],/合成/);
 const before=f.calls.length;await Promise.all([page.exportReport(event({kind:'xlsx'})),page.exportReport(event({kind:'xlsx'}))]);assert.equal(f.written.length,1);assert.equal(f.calls.slice(before).filter((c:any)=>c.payload?.kind==='reportCheck').length,2);assert.ok(page.data.filePath.endsWith('.xlsx'));page.openReport();assert.equal(f.opened.length,1);
 await page.moveWeek(event({delta:'1'}));assert.equal(page.data.filePath,'');assert.equal(page.data.filename,'');assert.deepEqual(f.errors,[]);
}));
test('V2前端：文件保存期间版本变化不交付混合报表，普通成员不能导出复制',async()=>fixture(async f=>{
 const page=await f.page('records');f.mutateOnWrite();await page.exportReport(event({kind:'txt'}));assert.equal(page.data.filePath,'');assert.match(f.errors[0],/变化/);
 f.who('member');await page.load();assert.equal(page.data.recordTab,'mine');const before=f.calls.length;await page.copyReport();await page.exportReport(event({kind:'xlsx'}));assert.equal(f.calls.length,before);assert.equal(f.copied.length,0);
}));
test('V2前端：复制上一周仅改本地时段与备注，不复制报名；未保存切周可取消',async()=>fixture(async f=>{
 const page=await f.page('availability',{week:'2'});assert.equal(page.data.optedIn,false);await page.copyAvailability();assert.deepEqual(page.data.selectedSlots,['1:1','1:2']);assert.equal(page.data.availabilityNote,'上一周备注');assert.equal(page.data.optedIn,false);assert.equal(page.data.dirty,true);assert.equal(f.calls.filter((c:any)=>c.operation==='command').length,0);
 f.confirm(false);await page.moveWeek(event({delta:'1'}));assert.equal(page.data.week,2);assert.equal(page.data.dirty,true);await page.saveAvailability();assert.equal(page.data.dirty,false);assert.equal((await f.repo.query('availability',{eq:{week:2}})).items[0].data.optedIn,false);
}));
test('无课时间：修改后启用原生返回提醒，离开可取消，保存成功解除提醒',async()=>fixture(async f=>{
 const page=await f.page('availability',{week:'2'});assert.equal(f.exitAlert(),false);
 page.toggleSlot(event({key:'1:1'}));assert.equal(f.exitAlert(),true);
 page.availabilityNote(event({},'尚未保存备注'));await page.load();assert.equal(page.data.availabilityNote,'尚未保存备注');assert.equal(f.exitAlert(),true);
 f.confirm(false);await page.navigate(event({target:'manage'}));assert.equal(f.navigation.length,0);assert.equal(page.data.dirty,true);assert.equal(f.exitAlert(),true);assert.equal(f.modals.at(-1).cancelText,'继续填写');
 f.confirm(true);await page.navigate(event({target:'manage'}));assert.equal(f.navigation.length,1);assert.equal(f.exitAlert(),false);
 page.onHide();await page.load();assert.equal(f.exitAlert(),false,'隐藏页迟到刷新不能给新页面启用提醒');
 page.onShow();while(page.data.busy)await new Promise(r=>setImmediate(r));assert.equal(f.exitAlert(),true,'返回原页仍有未保存内容，应恢复提醒');
 await page.saveAvailability();assert.equal(page.data.dirty,false);assert.equal(f.exitAlert(),false);
 const before=f.modals.length;await page.navigate(event({target:'manage'}));assert.equal(f.modals.length,before,'保存后不再询问离开');
}));
test('无课时间：报名、复制和备注都启用提醒，保存失败仍保留内容及提醒',async()=>fixture(async f=>{
 const page=await f.page('availability',{week:'2'});page.optIn(event({},true));assert.equal(f.exitAlert(),true);
 await page.copyAvailability();assert.equal(f.exitAlert(),true);page.availabilityNote(event({},'请保留'));
 f.failAvailabilitySave();await page.saveAvailability();assert.equal(page.data.dirty,true);assert.equal(page.data.availabilityNote,'请保留');assert.equal(f.exitAlert(),true);assert.match(f.errors.at(-1),/保存失败/);
 page.onUnload();assert.equal(f.exitAlert(),false);
}));
test('管理工作台：长列表中打开维护表单，自动定位表单且保留列表',async()=>fixture(async f=>{
 const page=await f.page('manage');const count=page.data.rows.length;await page.openForm('classSave');
 assert.equal(page.data.formType,'classSave');assert.equal(page.data.rows.length,count);assert.equal(f.scrolls.at(-1).selector,'#v2-active-form');
 await page.openForm('import');assert.equal(page.data.formType,'import');assert.equal(f.scrolls.at(-1).selector,'#v2-active-form');
}));
test('页面操作先于长内容：无课确认在时间表前，管理表单及清空在列表前，导入确认在预览前',()=>{
 const template=readFileSync(new URL('../miniprogram/templates/cloud.wxml',import.meta.url),'utf8');
 const form=readFileSync(new URL('../miniprogram/templates/cloud-form.wxml',import.meta.url),'utf8');
 const demo=readFileSync(new URL('../miniprogram/pages/availability/availability.wxml',import.meta.url),'utf8');
 const styles=readFileSync(new URL('../miniprogram/app.scss',import.meta.url),'utf8');
 assert.ok(template.indexOf('bindtap="saveAvailability"')<template.indexOf('wx:for="{{availabilityRows}}"'));
 assert.ok(demo.indexOf('bindtap="save"')<demo.indexOf('wx:for="{{rows}}"'));
 assert.ok(template.indexOf('<block wx:if="{{view === \'manage\'}}"><include src="cloud-form.wxml"')<template.indexOf('wx:for="{{visibleRows}}"'));
 assert.ok(template.indexOf('bindtap="clearBusiness">预览清空范围')<template.indexOf('wx:for="{{visibleRows}}"'));
 assert.ok(form.indexOf('bindtap="saveForm"')<form.indexOf('wx:for="{{fields}}"'));assert.ok(form.indexOf('bindtap="saveForm"')<form.indexOf('wx:for="{{importPreview}}"'));
 assert.match(styles,/\.v2-save-toolbar \{[^}]*position: sticky;[^}]*top: 0;/);
});
test('V2前端：安排默认下周、记录默认当前周，目标周传递和已取消任务过滤',async()=>fixture(async f=>{
 const current=boundedWeek(f.semester as Semester,new Date("2026-09-23T00:00:00Z"));const schedule=await f.page('schedule',{});assert.equal(schedule.data.week,Math.min(20,current+1));const records=await f.page('records',{});assert.equal(records.data.week,current);
 const first=await f.page('schedule',{week:'1',semesterId:'semester'});assert.equal(first.data.visibleTasks.length,2);first.search(event({},'待调整'));assert.equal(first.data.visibleTasks.length,1);assert.equal(first.data.visibleTasks[0].status,'pendingAdjustment');first.navigate(event({target:'availability'}));assert.match(f.navigation[0],/week=1&semesterId=semester/);
}));
test('V2前端：JSON/TXT文件只在本机预览，改内容后重新预览，超限和成员导入拦截',async()=>fixture(async f=>{
 const page=await f.page('manage');await page.openForm('import');const wx=(globalThis as any).wx;
 wx.chooseMessageFile=async()=>({tempFiles:[{path:'/fixture.json',size:100}]});wx.getFileSystemManager=()=>({readFile(o:any){o.success({data:'\ufeff'+JSON.stringify({courses:[{name:'合成导入课程',teacher:'测试教师',classroom:'101'}]})});}});
 await page.chooseImportFile();assert.ok(!page.data.fields[0].value.startsWith('\ufeff'));page.previewImport();assert.equal(page.data.importReady,true);assert.equal(page.data.importCount,1);assert.match(page.data.importPreview[0],/合成导入课程/);assert.equal(f.calls.filter((c:any)=>c.operation==='command').length,0);
 page.input(event({key:'text'},JSON.stringify({courses:[{name:'修改'}]})));assert.equal(page.data.importReady,false);await page.saveForm();assert.match(f.errors.pop(),/先解析预览/);assert.equal(f.calls.filter((c:any)=>c.operation==='command').length,0);
 page.input(event({key:'text'},JSON.stringify({courses:[{}],members:[]})));page.previewImport();assert.equal(page.data.importReady,false);assert.match(f.errors.pop(),/不支持导入成员/);
 wx.chooseMessageFile=async()=>({tempFiles:[{path:'/large.json',size:2*1024*1024}]});await page.chooseImportFile();assert.match(f.errors.pop(),/小于1MB/);
}));

test('V2前端：切回启用学期按校历选周，历史学期从首周浏览且刷新不跳周',async()=>fixture(async f=>{
 const page=await f.page('records');
 const choose=async(id:string)=>{page.chooseSemester(event({},String(page.data.semesters.findIndex((s:Entity)=>s.id===id))));while(page.data.busy)await new Promise(r=>setImmediate(r));assert.equal(page.data.error,'');};
 await choose('historical');assert.equal(page.data.week,1);await page.moveWeek(event({delta:'1'}));await page.load();assert.equal(page.data.week,2);assert.equal((await f.repo.workspace()).activeSemesterId,'semester');
 await choose('semester');assert.equal(page.data.week,boundedWeek(f.semester as Semester,new Date("2026-09-23T00:00:00Z")));assert.equal((await f.repo.workspace()).activeSemesterId,'semester');
}));

test('V2记录页：周统计随切周重新读取，跳过周与无学期不沿用旧进度',async()=>fixture(async f=>{
 const page=await f.page('records',{week:'1'});assert.equal(page.data.weekSubmitted,1);assert.equal(page.data.weekTotal,2);await page.showStats();assert.equal(page.data.statsCount,1);
 await page.moveWeek(event({delta:'1'}));assert.equal(page.data.week,2);assert.equal(page.data.skipped,true);assert.equal(page.data.weekSubmitted,0);assert.equal(page.data.weekTotal,0);assert.equal(page.data.statsLoaded,true);assert.equal(page.data.statsCount,0);assert.equal(page.data.stats.length,1,'仍有配置年级行，空状态必须依据记录数');assert.equal(page.data.stats[0].count,0);
 const reports=f.calls.filter((c:any)=>c.payload?.kind==='report');assert.equal(reports.length,2);assert.equal(reports.at(-1).payload.week,2);
}));
test('V2记录页：无启用学期保持空业务状态，不查询周记录',async()=>fixture(async f=>{
 const page=await f.page('records',{});assert.equal(page.data.semesterId,'');assert.equal(page.data.weekTotal,0);assert.equal(page.data.weekSubmitted,0);assert.equal(page.data.rows.length,0);assert.equal(f.calls.filter((c:any)=>c.payload?.kind==='week').length,0);
},''));
test('V2记录页：列表与统计排在导出前，按钮不再按原生文字宽度逐个换行',()=>{
 const template=readFileSync(new URL('../miniprogram/templates/cloud.wxml',import.meta.url),'utf8');const styles=readFileSync(new URL('../miniprogram/app.scss',import.meta.url),'utf8');
 assert.ok(template.indexOf('wx:for="{{visibleRows}}"')<template.indexOf('class="card v2-record-export"'));assert.ok(template.indexOf('statsLoaded}}"')<template.indexOf('class="card v2-record-export"'));
 assert.doesNotMatch(template,/bindtap="showStats"/);assert.match(template,/class="v2-report-actions"/);assert.match(template,/wx:if="\{\{statsCount > 0\}\}"[^]*wx:for="\{\{stats\}\}"[^]*<view wx:else class="v2-note"/);assert.match(styles,/\.v2-page \.v2-actions button \{[^}]*flex: 1 1 220rpx;[^}]*min-width: 0;[^}]*margin: 0;/);
});

test('V2记录页：有记录使用课程快照卡和轻量详情入口',async()=>fixture(async f=>{
 const page=await f.page('records',{week:'1'});assert.equal(page.data.visibleRows.length,1);const record=page.data.visibleRows[0];assert.equal(record.data.memberName,'合成成员');assert.equal(record.data.classLabel,'合成班');assert.equal(record.data.date,'2026-09-07');assert.equal(record.data.course.name,'合成数学');
 page.open(event({id:record.id}));assert.match(f.navigation[0],/\/pages\/record\/record\?id=record&semesterId=semester/);
 const template=readFileSync(new URL('../miniprogram/templates/cloud.wxml',import.meta.url),'utf8');const recordsCard=template.split("<block wx:if=\"{{view === 'records'}}\"><view class=\"row between v2-record-head\">")[1]?.split('</block>\n        <block wx:else>')[0] || '';
 assert.match(recordsCard,/item.data.memberName/);assert.match(recordsCard,/item.data.date/);assert.match(recordsCard,/item.data.classLabel/);assert.match(recordsCard,/item.data.course.start/);assert.match(recordsCard,/data-id="\{\{item.id\}\}" bindtap="open"/);assert.doesNotMatch(recordsCard,/<button|item.detail|item.statusLabel/);
}));

test('组部长所有名单导出与调整 handler 均关闭，统计和管理查看保留',async()=>fixture(async f=>{
 const manage=await f.page('manage');await manage.rowAction(event({id:'member',action:'leader'}));f.who('member');
 const schedule=await f.page('schedule');assert.equal(schedule.data.manager,true);assert.equal(schedule.data.canGenerate,false);assert.equal(schedule.data.canConfirm,false);
 const before=f.calls.length;await schedule.generate();await schedule.confirmPlan();await schedule.adjust(event({}));assert.equal(schedule.data.formType,'');
 schedule.setData({formType:'taskAdjust'});await schedule.saveForm();assert.equal(f.calls.length,before);
 const reports=await f.page('records');assert.equal(reports.data.canExportExcel,false);assert.equal(reports.data.rows.length,1);
 const count=f.calls.length;await reports.exportReport(event({kind:'xlsx'}));assert.equal(f.calls.length,count);assert.equal(f.written.length,0);
 await reports.copyReport();await reports.exportReport(event({kind:'txt'}));assert.equal(f.copied.length,0);assert.equal(f.written.length,0);assert.equal(f.calls.length,count);
 await reports.showStats();assert.equal(reports.data.statsLoaded,true);
 f.who('owner');await reports.load();assert.equal(reports.data.canExportExcel,true);
 await reports.exportReport(event({kind:'xlsx'}));assert.equal(f.written.length,1);
 await reports.copyReport();await reports.exportReport(event({kind:'txt'}));assert.equal(f.copied.length,1);assert.equal(f.written.length,2);assert.ok(f.calls.some((c:any)=>c.payload?.kind==='excelReport'));
}));

test('刷新失败或审核全局到期后，旧管理员页面不得保留生成确认和 Excel 操作',async()=>fixture(async f=>{
 const schedule=await f.page('schedule'),reports=await f.page('records');
 assert.equal(schedule.data.canGenerate,true);assert.equal(reports.data.canExportExcel,true);
 const wx=(globalThis as any).wx,original=wx.cloud.callFunction;
 wx.setStorageSync('xuedu.review.active.'+runtime.env,true);
 wx.cloud.callFunction=async()=>({result:{ok:false,code:'REVIEW_EXPIRED',error:'审核体验已到期'}});
 await schedule.load();await reports.load();
 assert.equal(schedule.data.canGenerate,false);assert.equal(schedule.data.canConfirm,false);assert.equal(reports.data.canExportExcel,false);assert.equal(reports.data.canExportNames,false);assert.equal(schedule.data.canAdjust,false);
 const before=f.calls.length;await schedule.generate();await schedule.confirmPlan();await reports.exportReport(event({kind:'xlsx'}));assert.equal(f.calls.length,before);
 assert.equal(wx.getStorageSync('xuedu.review.active.'+runtime.env),undefined);
 wx.cloud.callFunction=original;
 await reports.load();assert.equal(reports.data.error,'');assert.equal(reports.data.canExportExcel,true);
}));

test('干事全组列表、详情与完整 Excel 共用管理员导出器，TXT 和管理操作仍关闭',async()=>fixture(async f=>{
 const w=await f.repo.workspace();
 await f.repo.commit({epoch:w.epoch,workspaceVersion:w.version,permissionsVersion:w.permissionsVersion,identityKey:'owner',actorId:'admin',requestId:'officer-ui-seed',reads:[],changes:[
  {resource:'members',id:'officer',expectedVersion:0,value:{id:'officer',epoch:w.epoch,version:1,studentNo:'003',data:{role:'officer',name:'合成干事',studentNo:'003',classId:'c',active:true}}},
  {resource:'bindings',id:'bo',expectedVersion:0,value:{id:'bo',epoch:w.epoch,version:1,memberId:'officer',identityKey:'officer',data:{}}},
 ],result:{}});
 const admin=await f.page('records');await admin.exportReport(event({kind:'xlsx'}));const expected=f.written[0].data;
 f.who('officer');const page=await f.page('records');assert.equal(page.data.manager,false);assert.equal(page.data.canViewRecords,true);assert.equal(page.data.recordTab,'all');assert.equal(page.data.visibleRows[0].memberId,'member');assert.equal(page.data.weekSubmitted,1);assert.equal(page.data.weekTotal,2);
 const before=f.calls.length;await page.copyReport();await page.exportReport(event({kind:'txt'}));assert.equal(f.calls.length,before);
 await page.exportReport(event({kind:'xlsx'}));assert.deepEqual(Buffer.from(f.written[1].data),Buffer.from(expected));
 const exportCalls=f.calls.slice(before);assert.ok(exportCalls.some((c:any)=>c.payload?.kind==='excelReport'));assert.ok(!exportCalls.some((c:any)=>c.payload?.kind==='summaryReport'));assert.equal(exportCalls.filter((c:any)=>c.payload?.kind==='reportCheck'&&c.payload.format==='xlsx').length,2);
 const detail=await f.page('record',{id:'record',semesterId:'semester'});assert.equal(detail.data.record.id,'record');assert.equal(detail.data.canEdit,false);assert.ok(f.calls.some((c:any)=>c.operation==='photoUrls'&&c.payload.recordId==='record'));
 const availability=await f.page('availability');assert.deepEqual(availability.data.selectedSlots,[]);assert.equal(availability.data.availabilityNote,'');
 const schedule=await f.page('schedule');assert.equal(schedule.data.canGenerate,true);assert.equal(schedule.data.canConfirm,false);assert.equal(schedule.data.canAdjust,false);
 assert.equal(f.copied.length,0);assert.deepEqual(f.errors,[]);
}));
