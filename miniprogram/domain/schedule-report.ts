import { Course } from './types';
import { createXlsx, SheetData, Cell } from './xlsx';
export interface ScheduleReport {
  semesterName: string;
  week: number;
  members: {name:string;role:string;courses:{classLabel:string;course:Course;date:string}[]}[];
}
const roles:Record<string,string>={admin:'管理员',leader:'组部长',officer:'信息部干事',member:'干事'};
export function scheduleSheet(report:ScheduleReport):SheetData {
  const rows:Cell[][]=[['听课安排表'],[report.semesterName+' · 第 '+report.week+' 周'],['身份','姓名','班级','课程名称','上课日期 / 星期','节次','教室','任课教师','课程性质']];
  const merges=['A1:I1','A2:I2'];
  for(const member of report.members) {
    const first=rows.length+1;
    if(!member.courses.length)rows.push([roles[member.role] || '干事',member.name,null,null,null,null,null,null,null]);
    member.courses.forEach((option,index)=>{
      const c=option.course,day=new Date(option.date+'T12:00:00Z').getUTCDay();
      rows.push([index ? null : roles[member.role] || '干事',index ? null : member.name,option.classLabel,c.name,option.date+(Number.isNaN(day)?'':' / 周'+'日一二三四五六'[day]),`第${c.start}–${c.end}节`,c.classroom,c.teacher,c.nature]);
    });
    const last=rows.length;
    if(last>first)merges.push(`A${first}:A${last}`,`B${first}:B${last}`);
  }
  return {name:'听课安排表',rows,merges,columnWidths:[16,16,28,30,26,15,22,20,22],percentColumns:[],autoFilter:false};
}
export function exportScheduleXlsx(report:ScheduleReport):ArrayBuffer {return createXlsx([scheduleSheet(report)]);}
