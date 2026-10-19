import { Course } from '../types';
import { Entity } from './protocol';

export interface TaskCourseOption {
  occurrenceId: string;
  occurrenceVersion?: number;
  course: Course;
  classes: unknown[];
  classLabel: string;
  date: string;
}
/** Existing tasks remain a single option. Never discover extra courses on submission. */
export function taskCourseOptions(task: Entity): TaskCourseOption[] {
  if (Array.isArray(task.data.courseOptions)) return task.data.courseOptions as TaskCourseOption[];
  return [{occurrenceId:String(task.data.occurrenceId || ''),course:task.data.course as unknown as Course,
    classes:task.data.classes as unknown[] || [],classLabel:String(task.data.classLabel || ''),date:String(task.data.date || task.date || '')}];
}
