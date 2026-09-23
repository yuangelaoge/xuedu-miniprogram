import { Commit, Entity, PageResult, Query, Resource, Workspace } from "../../miniprogram/domain/v2/protocol";
export interface Repository {
  workspace(): Promise<Workspace>;
  count(resource: Resource, query: Query): Promise<number>;
  query(resource: Resource, query: Query): Promise<PageResult>;
  get(resource: Resource, id: string): Promise<Entity | undefined>;
  commit(command: Commit): Promise<Record<string, unknown>>;
}
