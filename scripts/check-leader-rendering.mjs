// Isolated WXML rendering check: no WeChat account, network, storage or business writes.
// Run with node --import tsx scripts/check-leader-rendering.mjs.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {registerCloudPage} from '../miniprogram/services/v2/page.ts';
import {runtime} from '../miniprogram/config/runtime.ts';
const dir=mkdtempSync(join(tmpdir(),'xuedu-role-render-'));
const collect=p=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(join(p,e.name)):e.name.endsWith('.wxml')?[join(p,e.name)]:[]);
const compiler=process.env.WECHAT_WCC || '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec/wcc';
const original={wx:globalThis.wx,Page:globalThis.Page,runtime:{...runtime}};
const nodes=n=>!n||typeof n!=='object'?[]:[n,...(n.children||[]).flatMap(nodes)];
const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');
let role='leader', definition, calls=0;
const entity=(id,data)=>({id,epoch:'synthetic-render',version:1,data});
const semester=entity('s',{name:'隔离学期',startDate:'2026-09-07',weeks:20,days:5,periods:14,status:'active'});
const weekData={semester,tasks:[{...entity('task',{status:'confirmed',memberName:'隔离成员',classLabel:'隔离班',course:{name:'隔离课程',start:1,end:2},date:'2026-09-07'}),memberId:'same-synthetic-account'}],occurrences:[],records:[],uncovered:[],draft:entity('draft',{status:'draft',reason:'隔离草稿'})};
try {
 execFileSync(compiler,[...collect('miniprogram'),'-o',join(dir,'compiled.js')]);
 const warnings=[];const sandbox={window:{},console:{warn:v=>warnings.push(v),log:v=>warnings.push(v)}};
 vm.createContext(sandbox);vm.runInContext(readFileSync(join(dir,'compiled.js'),'utf8'),sandbox);
 runtime.mode='cloud';runtime.env='isolated-role-render';
 globalThis.Page=p=>definition=p;
 globalThis.wx={getStorageSync:()=>'',setStorageSync(){},removeStorageSync(){},stopPullDownRefresh(){},showModal(){throw Error('Unexpected modal');},cloud:{init(){},async callFunction({data}){
  calls++;assert.equal(data.operation,'bootstrap');
  await new Promise(resolve=>setImmediate(resolve));
  return {result:{ok:true,data:{protocolVersion:2,epoch:'synthetic-render',resourceVersions:{workspace:1},data:{
   workspace:{id:'main',epoch:'synthetic-render',version:1,permissionsVersion:1,protocolVersion:2,activeSemesterId:'s',maintenance:'',maxExecutionMs:3000},
   member:entity('same-synthetic-account',{name:'隔离成员',role,active:true}),status:'ready',canInitialize:false,readPath:'single-rpc',
   home:{semester,week:1,weekData,summary:{taskCount:0,recordCount:0,coverage:0}},
   page:{semester,semesters:{items:[semester],cursor:''},week:1,weekData,list:{items:[],cursor:''},summary:{total:0,submitted:0,skipped:false}}
  }}}};
 }}};
 const results=[];
 registerCloudPage('home');const home={...definition,data:structuredClone(definition.data),setData(v,callback){Object.assign(this.data,v);callback?.();}};home.onLoad({});
 const homeLoading=home.onShow();
 for(const view of ['schedule','records']){
  registerCloudPage(view);const page={...definition,data:structuredClone(definition.data),setData(v,callback){Object.assign(this.data,v);callback?.();}};page.onLoad({week:'1'});
  await page.onShow();await homeLoading;assert.equal(page.data.error,'');assert.equal(home.data.error,'');
  const render=sandbox.$gwx(`miniprogram/pages/${view==='records'?'reports':'schedule'}/${view==='records'?'reports':'schedule'}.wxml`);
  for(const next of ['admin','leader','officer','leader','member']){
   role=next;await page.load();assert.equal(page.data.error,'');
   const buttons=nodes(render(page.data)).filter(n=>n.tag==='wx-button');
   const visible=buttons.map(text);
   const generate=buttons.some(n=>n.attr.bindtap==='generate'),confirm=buttons.some(n=>n.attr.bindtap==='confirmPlan'),excel=buttons.some(n=>n.attr['data-kind']==='xlsx');
   if(view==='schedule'){assert.equal(generate,['admin','officer'].includes(role));assert.equal(confirm,role==='admin');}
   else {assert.equal(excel,['admin','officer'].includes(role));assert.equal(visible.includes('名单 TXT'),role==='admin');}
   assert.equal(buttons.some(n=>n.attr.bindtap==='adjust'),view==='schedule' && role==='admin');
   if(role==='leader'){assert.doesNotMatch(text(render(page.data)),/排班工作台|本周汇总导出|直接复制请假|补排任务|转派／取消/);}
   results.push({view,role,generate,confirm,excel,buttons:visible});
  }
  page.onUnload();
 }
 assert.equal(home.data.role,"leader");
 const homeTree=sandbox.$gwx("miniprogram/pages/index/index.wxml")(home.data);
 assert.match(text(homeTree),/查看汇总/);
 home.onUnload();
 assert.deepEqual(warnings,[]);
 console.log(JSON.stringify({compiler:compiler.split('/').pop(),calls,results},null,2));
} finally {Object.assign(runtime,original.runtime);globalThis.wx=original.wx;globalThis.Page=original.Page;rmSync(dir,{recursive:true,force:true});}
