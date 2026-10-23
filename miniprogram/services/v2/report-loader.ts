import {AppState, SchoolClass} from '../../domain/types';
import {ApiResponse} from '../../domain/v2/protocol';
import {query} from './client';

type ReportKind = 'report' | 'excelReport' | 'namesReport';
interface ReportPage {
  reportPage?: boolean;
  metadata?: AppState;
  records?: AppState['records'];
  state?: AppState;
  version: number;
}
interface CompleteReport {state:AppState;version:number;}
function invalid():never {throw new Error('报表分包数据不完整，请重新生成');}

/** Assemble only a complete, single-version report; never let a partial download reach an exporter. */
export async function loadReportState(kind:ReportKind, semesterId:string, week:number):Promise<ApiResponse<CompleteReport>> {
  let metadata:AppState|undefined, firstVersion:number|undefined, firstEpoch='';
  let cursor='';
  const cursors=new Set<string>(), ids=new Set<string>(), records:AppState['records']=[];
  for(let pageNumber=0;pageNumber<1000;pageNumber++) {
    const response=await query<ReportPage>(kind,semesterId,{week,paged:true,
      ...(firstVersion===undefined ? {} : {reportVersion:firstVersion})},cursor);
    const part=response.data;
    if(!Number.isInteger(part.version) || part.version<0 || part.version!==response.resourceVersions.workspace) invalid();
    if(firstVersion!==undefined && (part.version!==firstVersion || response.epoch!==firstEpoch))
      throw new Error('报表数据已变化，请重新生成');
    if(part.reportPage!==true) {
      // Compatibility with the previously deployed, complete-response protocol.
      if(pageNumber!==0 || !part.state || !Array.isArray(part.state.records)) invalid();
      return {...response,data:{state:part.state,version:part.version}};
    }
    if(pageNumber===0) {
      metadata=part.metadata;
      if(!metadata || metadata.schema!==1 || metadata.activeSemesterId!==semesterId ||
        !Array.isArray(metadata.records) || metadata.records.length || !Array.isArray(metadata.classes) ||
        !Array.isArray(metadata.semesters) || !metadata.semesters.some(semester=>semester.id===semesterId)) invalid();
      firstVersion=part.version;firstEpoch=response.epoch;
    } else if(part.metadata!==undefined) invalid();
    if(!Array.isArray(part.records)) invalid();
    for(const record of part.records) {
      if(!record || !record.id || ids.has(record.id) || record.semesterId!==semesterId || record.week!==week) invalid();
      ids.add(record.id);records.push(record);
    }
    const next=response.cursor;
    if(next!==undefined && typeof next!=='string') invalid();
    if(!next) {
      const classes=new Map<string,SchoolClass>(metadata!.classes.map(klass=>[klass.id,klass]));
      // Frozen records override live class labels in the same order as the original report path.
      for(const record of records) for(const klass of record.classes || []) classes.set(klass.id,klass);
      const classRows=[...classes.values()], grades=[...new Set(classRows.map(klass=>klass.grade))];
      const state:AppState={...metadata!,classes:classRows,records,
        semesters:metadata!.semesters.map(semester=>semester.id===semesterId ? {...semester,grades} : semester)};
      return {...response,cursor:'',data:{state,version:firstVersion!}};
    }
    if(next===cursor || cursors.has(next) || !part.records.length) invalid();
    cursors.add(next);cursor=next;
  }
  throw new Error('报表分包数量异常，请联系管理员');
}
