import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const compiler = process.env.WECHAT_WCC || '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec/wcc';
const files = (dir: string): string[] => readdirSync(dir, {withFileTypes:true}).flatMap(e =>
  e.isDirectory() ? files(join(dir,e.name)) : e.name.endsWith('.wxml') ? [join(dir,e.name)] : []);
const nodes = (n: any): any[] => !n || typeof n !== 'object' ? [] : [n,...(n.children || []).flatMap(nodes)];
const text = (n: any): string => typeof n === 'string' ? n : (n?.children || []).map(text).join('');

// Render the actual index -> cloud -> home chain, including task button datasets.
// Synthetic page data only: no account, cloud API, database or storage access.
test('首页模板明确传递本周/下周任务，字段、人数及填写入口不串行', {skip:!existsSync(compiler)}, () => {
  const dir = mkdtempSync(join(tmpdir(),'xuedu-home-render-'));
  try {
    const output = join(dir,'compiled.js');
    execFileSync(compiler,[...files('miniprogram'),'-o',output]);
    const warnings: unknown[] = [];
    const sandbox: any = {window:{},console:{warn:(v:unknown)=>warnings.push(v),log:(v:unknown)=>warnings.push(v)}};
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(output,'utf8'),sandbox);
    const render = sandbox.$gwx('miniprogram/pages/index/index.wxml');
    const task = (id:string,status='confirmed') => ({id,classLabel:id+'班',
      course:{name:id+'课程',teacher:id+'教师',classroom:id+'教室'},timeLabel:id+'时间',
      status,done:status==='submitted',recordId:status==='submitted' ? id+'记录' : '',
      courseCounts:[{id:id+'a',label:id+'课程A',count:'60 人',combined:true},
        {id:id+'b',label:id+'课程B',count:'未填写',combined:false}]});
    const current = task('本周'), next = task('下周'), completed = task('完成','submitted');
    const data = {cloudMode:true,view:'home',hasLoaded:true,memberId:'synthetic',
      activeSemesterId:'s',semesterId:'s',week:8,nextWeek:9,maxWeek:20,
      homeTasks:[current,completed],homeNextTasks:[next],tasks:[current,completed],
      item:task('错误外层'),task:task('错误页面变量')};
    const cards = (data:any) => nodes(render(data)).filter(n=>n.attr?.class==='home-task');
    let rendered = cards(data);
    assert.equal(rendered.length,3);
    for (const [i,t] of [current,completed,next].entries()) {
      const card = rendered[i], visible = text(card);
      for (const value of [t.classLabel,t.course.name,t.course.teacher,t.course.classroom,t.timeLabel,
        t.id+'课程A',t.id+'课程B','课表人数：60 人（合班合计）','课表人数：未填写']) assert.ok(visible.includes(value),value);
      assert.doesNotMatch(visible,/错误外层|错误页面变量|查看安排/);
      const button = nodes(card).find(n=>n.tag==='wx-button');
      assert.equal(button.attr.bindtap,'open');
      assert.equal(button.attr['data-id'],t.done ? t.recordId : t.id);
      assert.ok(visible.includes(t.done ? '查看记录' : '填写记录'));
    }
    // A refresh may change order/status, or clear next-week tasks independently.
    rendered = cards({...data,homeTasks:[completed,current],homeNextTasks:[]});
    assert.equal(rendered.length,2);
    assert.ok(text(rendered[0]).includes('完成课程'));
    const adjusting = task('调整','pendingAdjustment');
    const card = cards({...data,homeTasks:[adjusting],homeNextTasks:[]})[0];
    assert.match(text(card),/待调整/);
    assert.match(text(card),/查看安排/);
    assert.doesNotMatch(text(card),/填写记录/);
    assert.deepEqual(warnings,[]);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
