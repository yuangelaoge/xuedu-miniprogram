import test from 'node:test';
import assert from 'node:assert/strict';
import {createGatewayV2} from '../server/v2/gateway';
import {MemoryRepository} from '../server/v2/memory';
import {registerCloudPage} from '../miniprogram/services/v2/page';
import {runtime} from '../miniprogram/config/runtime';
import {Entity,Workspace} from '../miniprogram/domain/v2/protocol';
const ev=(key:string,value='')=>({currentTarget:{dataset:{key}},detail:{value}});
let serial=0;
async function fixture(work:(f:any)=>Promise<void>){
 const g=globalThis as any,oldWx=g.wx,oldPage=g.Page,oldRuntime={...runtime};runtime.mode='cloud';runtime.env='record-form-'+ ++serial;
 const e=(id:string,data:any,index:any={}):Entity=>({id,epoch:'form',version:1,data,...index});
 const w:Workspace={id:'main',epoch:'form',version:1,permissionsVersion:1,protocolVersion:2,activeSemesterId:'s',maintenance:'',maxExecutionMs:3000};
 const course={id:'c',name:'合成数学',teacher:'数学老师',nature:'必修',classIds:['class-00'],weekday:1,start:1,end:2,classroom:'101',weeks:[1,2],expected:20};
 const data={memberName:'合成成员',classLabel:'合成班',date:'2026-09-07',course,classes:[{id:'class-00',name:'合成班',grade:'26',major:'计算机'}]};
 const metrics={expected:20,actual:19,late:0,early:0,sleep:-1,phone:0,talk:0,other:0};
 const record={...data,metrics,photos:['existing'],absentNames:'无',leaveNames:'同学甲',firstSubmittedAt:'2026-09-07T00:00:00Z',createdAt:'2026-09-07T00:00:00Z',revision:1};
 const repo=new MemoryRepository(w,{members:[e('admin',{name:'管理员',role:'admin',active:true,classId:'class-00',studentNo:'001'},{studentNo:'001'}),e('member',{name:'合成成员',role:'member',active:true,classId:'class-01',studentNo:'002'},{studentNo:'002'}),e('other',{name:'其他成员',role:'member',active:true,classId:'class-01',studentNo:'003'},{studentNo:'003'})],bindings:[e('ba',{},{identityKey:'owner',memberId:'admin'}),e('bm',{},{identityKey:'member',memberId:'member'}),e('bo',{},{identityKey:'other',memberId:'other'})],classes:Array.from({length:51},(_,i)=>e('class-'+String(i).padStart(2,'0'),{name:i===50?'另一年级班':'合成班'+i,grade:i===50?'25':'26',major:'计算机',active:true})),semesters:[e('s',{name:'合成学期',startDate:'2026-09-07',weeks:20,days:5,periods:14})],courses:[e('c',{name:course.name,course,active:true},{semesterId:'s'}),e('last',{name:'另一课程',course:{...course,name:'另一课程',teacher:'另一老师',classIds:['class-50']},active:true},{semesterId:'s'})],tasks:[e('task',{...data,status:'confirmed',occurrenceId:'occ'},{memberId:'member',semesterId:'s',week:1}),e('old-task',{...data,status:'submitted'},{memberId:'member',semesterId:'s',week:1})],occurrences:[e('occ',{...data,status:'active'},{semesterId:'s',week:1,date:'2026-09-07'})],records:[e('record',record,{memberId:'member',semesterId:'s',week:1,taskId:'old-task'})],record_versions:[e('old-version',{...record,recordVersion:1},{memberId:'member',semesterId:'s',week:1,taskId:'old-task',recordId:'record'})],photos:[e('existing',{storageId:'private-existing'},{semesterId:'s',memberId:'member',taskId:'old-task',recordId:'record'})]});
 let loseReply='',uploadCount=0;let who='member',definition:any,urlRevision=0,hold:Promise<void>|undefined,release:()=>void=()=>{};const calls:any[]=[],previews:any[]=[],errors:string[]=[];const storage=new Map();
 const gateway=createGatewayV2({repository:repo,appid:'app',bootstrapOpenid:'owner',maxExecutionMs:3000,uuid:()=>`form-${++serial}`,now:()=>Date.parse('2026-09-07T01:00:00Z'),photos:{async upload(path){uploadCount++;if(hold)await hold;return path;},async urls(ids){return ids.map(id=>`https://synthetic.invalid/${++urlRevision}/${id}`);},async list(){return [];},async delete(){}}});
 g.Page=(p:any)=>definition=p;g.wx={getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:any)=>storage.set(k,v),removeStorageSync:(k:string)=>storage.delete(k),showToast(){},async showModal(o:any){if(o.showCancel===false)errors.push(o.content);return {confirm:true};},previewImage(o:any){previews.push(o);},async chooseMedia(){return {tempFiles:[{tempFilePath:'/selected-photo'}]};},getFileSystemManager(){return {readFileSync(){return 'aGVsbG8=';}};},cloud:{init(){},async callFunction({data}:any){calls.push(data);try{const result=await gateway(data,{OPENID:who,APPID:'app'});if(loseReply===(data.operation==='command'?data.payload.type:data.operation)){loseReply='';throw new Error('模拟回包丢失');}return {result:{ok:true,data:result}};}catch(e){return {result:{ok:false,error:(e as Error).message}};}}}};
 const page=async(view:any,q:any={})=>{registerCloudPage(view);const p={...definition,data:structuredClone(definition.data),setData(v:any){Object.assign(this.data,v);}};p.onLoad({semesterId:'s',week:'1',...q});await p.load();assert.equal(p.data.error,'');return p;};
 try{await work({repo,page,calls,previews,errors,storage,loseReply:(kind:string)=>loseReply=kind,uploadCount:()=>uploadCount,who:(v:string)=>who=v,holdUpload:()=>{hold=new Promise(r=>release=r);},releaseUpload:()=>{release();hold=undefined;}});}finally{release();g.wx=oldWx;g.Page=oldPage;Object.assign(runtime,oldRuntime);}
}
test('V2记录分组：缺失保留-1，补零只填空白异常项，快捷名单不改人数或归属',async()=>fixture(async f=>{
 const p=await f.page('submission',{taskId:'task'});assert.equal(p.data.metricFields.length,8);assert.equal(p.data.nameFields.length,2);assert.equal(p.data.feedbackFields.length,4);assert.equal(p.data.recordContext.id,'task');
 p.input(ev('late','2'));p.markMissing(ev('sleep'));p.zeroRemaining();const values=()=>Object.fromEntries(p.data.fields.map((v:any)=>[v.key,v.value]));assert.equal(values().expected,'');assert.equal(values().actual,'');assert.equal(values().late,'2');assert.equal(values().sleep,'信息缺失');assert.equal(values().phone,'0');assert.equal(values().evaluation,'');
 p.noNames(ev('absentNames'));p.noNames(ev('leaveNames'));p.noNames(ev('taskId'));assert.equal(values().absentNames,'无');assert.equal(p.data.formExtra.taskId,'task');
 await p.saveForm();assert.match(f.errors.pop(),/全部人数/);assert.equal(f.calls.filter((c:any)=>c.payload?.type==='recordSubmit').length,0);
 p.input(ev('expected','20'));p.input(ev('actual','19'));await p.choosePhotos();await p.saveForm();assert.deepEqual(f.errors,[]);
 const submitted=(await f.repo.query('records',{eq:{taskId:'task'}})).items[0];assert.equal(submitted.data.metrics.sleep,-1);assert.equal(submitted.data.metrics.late,2);assert.equal(submitted.data.metrics.phone,0);assert.equal(submitted.memberId,'member');
}));
test('V2更正：分组共用字段与原因，草稿只恢复已知文字，实际人数非法仍由服务端拒绝',async()=>fixture(async f=>{
 const p=await f.page('record',{id:'record'});p.editRecord();assert.ok(p.data.feedbackFields.some((v:any)=>v.key==='reason'));assert.equal(p.data.metricFields.find((v:any)=>v.key==='sleep').value,'信息缺失');p.zeroRemaining();assert.equal(p.data.metricFields.find((v:any)=>v.key==='sleep').value,'信息缺失');
 p.input(ev('actual','21'));p.input(ev('reason','核对'));await p.saveForm();assert.match(f.errors.pop(),/实到人数不能大于应到人数/);assert.equal((await f.repo.get('records','record')).version,1);
 const submit=await f.page('submission',{taskId:'task'});submit.input(ev('actual','7'));submit.saveDraft();const key=[...f.storage.keys()].find((k:any)=>k.includes('.task'));f.storage.get(key).fields.push({key:'memberId',value:'other'});const reopened=await f.page('submission',{taskId:'task'});assert.equal(reopened.data.metricFields.find((v:any)=>v.key==='actual').value,'7');assert.equal(reopened.data.fields.some((v:any)=>v.key==='memberId'),false);
 f.storage.set(key,{fields:{invalid:true}});const malformed=await f.page('submission',{taskId:'task'});assert.equal(malformed.data.metricFields.find((v:any)=>v.key==='actual').value,'');
}));
test('V2照片：选择中缩略图、上传锁定、授权后预览；纠错和详情每次刷新临时链接',async()=>fixture(async f=>{
 const p=await f.page('submission',{taskId:'task'});f.holdUpload();const uploading=p.choosePhotos();while(!p.data.uploadingPhoto)await new Promise(r=>setImmediate(r));assert.equal(p.data.uploadingPhoto,'/selected-photo');assert.equal(p.data.busy,true);await p.choosePhotos();assert.equal(p.data.busy,true);assert.equal(p.data.uploadingPhoto,'/selected-photo');p.previewUploadingPhoto();assert.equal(f.previews[0].current,'/selected-photo');p.removePhoto({currentTarget:{dataset:{index:'0'}}});assert.equal(p.data.photoIds.length,0);f.releaseUpload();await uploading;assert.equal(p.data.photoIds.length,1);assert.equal(p.data.uploadingPhoto,'');
 await p.previewFormPhoto({currentTarget:{dataset:{index:'0'}}});assert.match(f.previews.at(-1).current,/synthetic.invalid/);assert.equal(f.calls.at(-1).operation,'photoUrls');
 const detail=await f.page('record',{id:'record'});const old=detail.data.photoUrls[0];detail.editRecord();await detail.previewFormPhoto({currentTarget:{dataset:{index:'0'}}});assert.notEqual(detail.data.formPhotos[0],old);const newUrl=detail.data.formPhotos[0];await detail.previewPhoto({currentTarget:{dataset:{url:old}}});assert.notEqual(detail.data.photoUrls[0],newUrl);
 f.who('other');const before=f.previews.length;await detail.previewFormPhoto({currentTarget:{dataset:{index:'0'}}});assert.equal(f.previews.length,before);assert.match(f.errors.pop(),/他人照片/);
 assert.equal((await f.repo.get('photos','existing')).recordId,'record');assert.equal((await f.repo.query('record_versions',{})).items.length,1);
}));
test('V2课程：年级依照班级资料、保持分页，补加载后按年级和教师筛选且可看有效周次',async()=>fixture(async f=>{
 const p=await f.page('courses');assert.equal(p.data.rows.length,2);assert.equal(p.data.courseClasses.length,50);assert.equal(p.data.courseClassesIncomplete,true);assert.deepEqual(p.data.courseGrades,['26']);assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.page.view,'courses');
 await p.moreCourseClasses();assert.equal(p.data.courseClassesIncomplete,false);assert.deepEqual(p.data.courseGrades,['25','26']);p.filterCourseGrade({currentTarget:{dataset:{grade:'25'}}});assert.equal(p.data.visibleRows.length,1);assert.equal(p.data.visibleRows[0].id,'last');p.search(ev('', '另一老师'));assert.equal(p.data.visibleRows.length,1);p.search(ev('','数学老师'));assert.equal(p.data.visibleRows.length,0);
 p.courseDetails({currentTarget:{dataset:{id:'last'}}});assert.match(f.errors.pop(),/有效周次：1、2/);assert.equal(f.calls.filter((c:any)=>c.operation==='command').length,0);
}));

test('未修改的旧页面：照片和提交回包丢失后，新编号重试复用成功结果',async()=>fixture(async f=>{
 const p=await f.page('submission',{taskId:'task'});
 p.input(ev('expected','20'));p.input(ev('actual','19'));p.zeroRemaining();
 f.loseReply('photo');await p.choosePhotos();assert.match(f.errors.pop(),/模拟回包丢失/);assert.equal(p.data.photoIds.length,0);
 await p.choosePhotos();assert.equal(p.data.photoIds.length,1);assert.equal(f.uploadCount(),1);
 const photos=f.calls.filter((c:any)=>c.operation==='photo');assert.notEqual(photos[0].requestId,photos[1].requestId);
 f.loseReply('recordSubmit');await p.saveForm();assert.match(f.errors.pop(),/模拟回包丢失/);assert.equal(p.data.formType,'recordSubmit');
 await p.saveForm();assert.deepEqual(f.errors,[]);
 const writes=f.calls.filter((c:any)=>c.payload?.type==='recordSubmit');assert.notEqual(writes[0].requestId,writes[1].requestId);
 const records=(await f.repo.query('records',{eq:{taskId:'task'}})).items;assert.equal(records.length,1);
 assert.equal((await f.repo.query('record_versions',{eq:{recordId:records[0].id}})).items.length,1);
 assert.equal(f.calls.some((c:any)=>c.operation==='resolveWrite'),false);
}));
test('未修改的旧更正页：成功回包丢失后重复保存不增加历史版本',async()=>fixture(async f=>{
 const p=await f.page('record',{id:'record'});p.editRecord();p.input(ev('actual','18'));p.input(ev('reason','重新核对'));
 f.loseReply('recordEdit');await p.saveForm();assert.match(f.errors.pop(),/模拟回包丢失/);await p.saveForm();assert.deepEqual(f.errors,[]);
 assert.equal((await f.repo.get('records','record')).version,2);
 assert.equal((await f.repo.query('record_versions',{eq:{recordId:'record'}})).items.length,2);
 const writes=f.calls.filter((c:any)=>c.payload?.type==='recordEdit');assert.notEqual(writes[0].requestId,writes[1].requestId);
}));
