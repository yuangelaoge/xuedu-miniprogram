import { AppState, Metrics, Observation } from '../../miniprogram/domain/types';

/** Entirely synthetic: no gateway, environment, personal data or photos. */
export function weeklyChartFixture():AppState {
  const sid='offline-chart-semester';
  const state:AppState={schema:1,activeSemesterId:sid,actorId:'simulation-admin',semesters:[{id:sid,name:'2026秋（本地模拟）',edition:'模拟数据 · 不用于业务',startDate:'2026-08-31',weeks:20,grades:['24','25','26'],days:5,periods:12}],classes:[],members:[{id:'simulation-admin',name:'模拟管理员',studentNo:'SYNTHETIC',classId:'',role:'admin',active:true}],applications:[],courses:[],availability:[],plans:[],drafts:[],records:[],audit:[],generation:1};
  const add=(grade:string,names:string[],expected:number,actual:number,late:number,discipline:number)=>{
    const n=state.records.length,id='synthetic-'+n;
    const classes=names.map(name=>({id:'class-'+grade+'-'+name,grade,major:name.replace(/\d+班$/,''),name:grade+name}));
    for(const c of classes)if(!state.classes.some(k=>k.id===c.id))state.classes.push(c);
    const course={id:'course-'+id,semesterId:sid,name:'模拟课程'+(n+1),teacher:'模拟教师',nature:'专业必修课',classIds:classes.map(c=>c.id),classroom:'模拟教室',weekday:1,start:3,end:4,weeks:[8],expected};
    state.courses.push(course);
    const metrics:Metrics={expected,actual,late,early:0,sleep:discipline<0?-1:Math.min(discipline,Math.max(0,actual)),phone:discipline<0?-1:Math.max(0,discipline-actual),talk:discipline<0?-1:0,other:0};
    const record:Observation={id,taskId:'task-'+id,semesterId:sid,week:8,memberId:'synthetic-member',memberName:'模拟听课成员',course,classes,classLabel:classes.map(c=>c.name).join(' / '),date:'2026-10-19',metrics,absentNames:'模拟：无',leaveNames:'模拟：无',otherDescription:'',evaluation:'仅用于本地图表效果演示',feedback:'虚拟数据，请勿作为实际统计',suggestion:'',photos:[],createdAt:'2026-10-23T00:00:00Z'};
    state.records.push(record);
  };
  // A normal nine-bar week, with the supplied reference's attendance ratios.
  add('24',['计科1班','计科2班'],50,50,0,1);
  add('24',['网工1班','网工2班'],60,60,3,3);
  add('24',['软普3班','软普4班'],68,64,4,9);
  add('24',['计创1班'],71,66,9,10);
  add('24',['计创2班'],71,66,10,12);
  add('24',['自动化1班','自动化2班'],51,47,3,2);
  add('24',['软普1班','软普2班'],70,60,9,15);
  add('24',['计科3班','计科4班'],50,40,0,6);
  add('24',['软工中外3班','软工中外4班'],58,46,8,10);
  // Exact thresholds and values immediately either side, with a repeated class.
  add('25',['边界甲1班'],10000,8499,0,0);
  add('25',['边界乙1班'],10000,8500,425,425);
  add('25',['边界丙1班'],10000,9499,475,475);
  add('25',['边界丁1班'],10000,9500,1425,1425);
  add('25',['边界戊1班'],10000,10000,1501,1501);
  add('25',['边界乙1班'],10000,10000,501,501);
  add('26',['零出勤1班'],50,0,0,0);
  add('26',['零分母1班'],0,0,0,0);
  add('26',['缺失1班'],-1,-1,-1,-1);
  add('26',['行为人次1班'],50,50,0,60);
  return state;
}
