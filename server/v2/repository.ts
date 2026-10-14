import { SchedulingRead } from "./scheduling-read";
import { ApiResponse, Commit, Entity, PageResult, Query, Resource, Workspace } from "../../miniprogram/domain/v2/protocol";
export interface Repository {
  schedulingRead?(identityKey: string, request: Record<string, unknown>): Promise<SchedulingRead | null>;
  bootstrapPage?(identityKey: string, request: Record<string, unknown>, canInitialize: boolean): Promise<ApiResponse | null>;
  workspace(): Promise<Workspace>;
  count(resource: Resource, query: Query): Promise<number>;
  query(resource: Resource, query: Query): Promise<PageResult>;
  get(resource: Resource, id: string): Promise<Entity | undefined>;
  commit(command: Commit): Promise<Record<string, unknown>>;
}
