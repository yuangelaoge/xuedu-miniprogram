-- V2 split storage. Offline-reviewed migration; never deletes the legacy workspace.
-- Apply only in the separately approved maintenance window. All V1 writes stop
-- at installation. Existing unfinished legacy cleanup MUST be completed first.
BEGIN;
DO $$ DECLARE pending boolean; BEGIN
  IF to_regclass('xuedu_private.workspace') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM xuedu_private.workspace WHERE coalesce((document->>''cleaning'')::boolean,false) OR document->''resetAll'' IS NOT NULL AND document->''resetAll'' <> ''null''::jsonb OR document->''businessClear'' IS NOT NULL AND document->''businessClear'' <> ''null''::jsonb)' INTO pending;
    IF pending THEN RAISE EXCEPTION 'LEGACY_MAINTENANCE_PENDING'; END IF;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS xuedu_v2;
REVOKE ALL ON SCHEMA xuedu_v2 FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS xuedu_v2.workspace (
 id text PRIMARY KEY CHECK(id='main'), epoch text NOT NULL, version bigint NOT NULL DEFAULT 0,
 permissions_version bigint NOT NULL DEFAULT 0, active_semester_id text NOT NULL DEFAULT '',
 maintenance text NOT NULL DEFAULT '', max_execution_ms integer NOT NULL DEFAULT 0,
 CHECK(version>=0 AND permissions_version>=0), CHECK(max_execution_ms>=0 AND max_execution_ms<=900000)
);
ALTER TABLE xuedu_v2.workspace ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON xuedu_v2.workspace FROM PUBLIC, anon, authenticated;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['members','bindings','applications','classes','semesters','semester_classes','courses','course_versions','occurrences','exceptions','availability','plans','tasks','records','record_versions','photos','audit','requests','maintenance','rebindings'] LOOP
  EXECUTE format('CREATE TABLE IF NOT EXISTS xuedu_v2.%I (id text PRIMARY KEY, epoch text NOT NULL, version bigint NOT NULL CHECK(version>0), data jsonb NOT NULL CHECK(jsonb_typeof(data)=''object'' AND octet_length(data::text)<=131072), semester_id text, week integer, member_id text, task_id text, record_id text, parent_id text, identity_key text, student_no text, date text, sort_key text)',r);
  EXECUTE format('ALTER TABLE xuedu_v2.%I ENABLE ROW LEVEL SECURITY',r);
  EXECUTE format('REVOKE ALL ON xuedu_v2.%I FROM PUBLIC, anon, authenticated',r);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON xuedu_v2.%I(epoch,id)',r||'_epoch_page',r);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON xuedu_v2.%I(semester_id,week,id)',r||'_week_page',r);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON xuedu_v2.%I(member_id,id)',r||'_member_page',r);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON xuedu_v2.%I(parent_id,id)',r||'_parent_page',r);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON xuedu_v2.%I(record_id,id)',r||'_record_page',r);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON xuedu_v2.%I(identity_key,id)',r||'_identity_page',r);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON xuedu_v2.%I(task_id,id)',r||'_task_page',r);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON xuedu_v2.%I(semester_id,date,id)',r||'_date_page',r);
   EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON xuedu_v2.%I(member_id,(data->>''status''),id)',r||'_member_status_page',r);
 END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS members_student_no_unique ON xuedu_v2.members(student_no) WHERE student_no IS NOT NULL AND student_no<>'';
CREATE UNIQUE INDEX IF NOT EXISTS bindings_identity_unique ON xuedu_v2.bindings(identity_key);
CREATE UNIQUE INDEX IF NOT EXISTS bindings_member_unique ON xuedu_v2.bindings(member_id);
CREATE UNIQUE INDEX IF NOT EXISTS records_task_unique ON xuedu_v2.records(task_id) WHERE task_id IS NOT NULL AND task_id<>'';
CREATE UNIQUE INDEX IF NOT EXISTS availability_member_week_unique ON xuedu_v2.availability(semester_id,week,member_id);
CREATE UNIQUE INDEX IF NOT EXISTS semester_classes_unique ON xuedu_v2.semester_classes(semester_id,parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS applications_identity_unique ON xuedu_v2.applications(identity_key);
CREATE UNIQUE INDEX IF NOT EXISTS requests_key_unique ON xuedu_v2.requests(epoch,identity_key,parent_id);

CREATE OR REPLACE FUNCTION xuedu_v2.require_server() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'server role required' USING ERRCODE='42501'; END IF;
END $$;
CREATE OR REPLACE FUNCTION xuedu_v2.resource_name(r text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF r IS NULL OR NOT r=ANY(ARRAY['members','bindings','applications','classes','semesters','semester_classes','courses','course_versions','occurrences','exceptions','availability','plans','tasks','records','record_versions','photos','audit','requests','maintenance','rebindings']) THEN RAISE EXCEPTION 'INVALID_RESOURCE'; END IF;
 RETURN r;
END $$;
CREATE OR REPLACE FUNCTION xuedu_v2.entity(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object('id',j->'id','epoch',j->'epoch','version',j->'version','data',j->'data','semesterId',j->'semester_id','week',j->'week','memberId',j->'member_id','taskId',j->'task_id','recordId',j->'record_id','parentId',j->'parent_id','identityKey',j->'identity_key','studentNo',j->'student_no','date',j->'date','sortKey',j->'sort_key'));
$$;
CREATE OR REPLACE FUNCTION public.xuedu_v2_workspace() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w xuedu_v2.workspace; BEGIN
 PERFORM xuedu_v2.require_server();
 SELECT * INTO w FROM xuedu_v2.workspace WHERE id='main';
 IF NOT FOUND THEN
  RETURN jsonb_build_object('id','main','epoch','initial','version',0,'permissionsVersion',0,'protocolVersion',2,'activeSemesterId','','maintenance','','maxExecutionMs',0);
 END IF;
 RETURN jsonb_build_object('id',w.id,'epoch',w.epoch,'version',w.version,'permissionsVersion',w.permissions_version,'protocolVersion',2,'activeSemesterId',w.active_semester_id,'maintenance',w.maintenance,'maxExecutionMs',w.max_execution_ms);
END $$;
CREATE OR REPLACE FUNCTION public.xuedu_v2_query(p_resource text,p_query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer:=coalesce((p_query->>'limit')::integer,50); k text; v jsonb; col text; predicate text:='TRUE'; sql text; rows jsonb; cnt integer; BEGIN
 PERFORM xuedu_v2.require_server(); PERFORM xuedu_v2.resource_name(p_resource);
 IF n<1 OR n>100 THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(coalesce(p_query->'eq','{}')) UNION ALL SELECT key,value FROM jsonb_each(coalesce(p_query->'in','{}')) LOOP
  col:=CASE k WHEN 'semesterId' THEN 'semester_id' WHEN 'memberId' THEN 'member_id' WHEN 'taskId' THEN 'task_id' WHEN 'recordId' THEN 'record_id' WHEN 'parentId' THEN 'parent_id' WHEN 'identityKey' THEN 'identity_key' WHEN 'studentNo' THEN 'student_no' WHEN 'sortKey' THEN 'sort_key' ELSE k END;
  IF NOT col=ANY(ARRAY['id','epoch','semester_id','week','member_id','task_id','record_id','parent_id','identity_key','student_no','date','sort_key','status']) THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
  IF jsonb_typeof(v)='array' THEN
   IF jsonb_array_length(v)>100 THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
   IF col='status' THEN predicate:=predicate||format(' AND data->>''status'' IN (SELECT jsonb_array_elements_text(%L::jsonb))',v::text);
   ELSIF col='week' THEN predicate:=predicate||format(' AND week IN (SELECT jsonb_array_elements_text(%L::jsonb)::integer)',v::text);
   ELSE predicate:=predicate||format(' AND %I IN (SELECT jsonb_array_elements_text(%L::jsonb))',col,v::text); END IF;
  ELSE IF col='status' THEN predicate:=predicate||format(' AND data->>''status''=%L',v#>>'{}'); ELSE predicate:=predicate||format(' AND %I=%L',col,v#>>'{}'); END IF; END IF;
 END LOOP;
 IF coalesce(p_query->>'after','')<>'' THEN predicate:=predicate||format(' AND id COLLATE "C">%L COLLATE "C"',p_query->>'after'); END IF;
 IF p_query ? 'dateFrom' THEN predicate:=predicate||format(' AND date>=%L',p_query->>'dateFrom'); END IF;
 IF p_query ? 'dateTo' THEN predicate:=predicate||format(' AND date<=%L',p_query->>'dateTo'); END IF;
 sql:=format('SELECT coalesce(jsonb_agg(xuedu_v2.entity(to_jsonb(t))),''[]''::jsonb) FROM (SELECT * FROM xuedu_v2.%I WHERE %s ORDER BY id COLLATE "C" LIMIT %s) t',p_resource,predicate,n+1);
 EXECUTE sql INTO rows; cnt:=jsonb_array_length(rows);
 RETURN jsonb_build_object('items',CASE WHEN cnt>n THEN rows-(cnt-1) ELSE rows END,'cursor',CASE WHEN cnt>n THEN rows->(n-1)->>'id' ELSE '' END);
END $$;
CREATE OR REPLACE FUNCTION public.xuedu_v2_count(p_resource text,p_query jsonb) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer:=coalesce((p_query->>'limit')::integer,50); k text; v jsonb; col text; predicate text:='TRUE'; sql text; total bigint; BEGIN
 PERFORM xuedu_v2.require_server(); PERFORM xuedu_v2.resource_name(p_resource);
 IF n<1 OR n>100 THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(coalesce(p_query->'eq','{}')) UNION ALL SELECT key,value FROM jsonb_each(coalesce(p_query->'in','{}')) LOOP
  col:=CASE k WHEN 'semesterId' THEN 'semester_id' WHEN 'memberId' THEN 'member_id' WHEN 'taskId' THEN 'task_id' WHEN 'recordId' THEN 'record_id' WHEN 'parentId' THEN 'parent_id' WHEN 'identityKey' THEN 'identity_key' WHEN 'studentNo' THEN 'student_no' WHEN 'sortKey' THEN 'sort_key' ELSE k END;
  IF NOT col=ANY(ARRAY['id','epoch','semester_id','week','member_id','task_id','record_id','parent_id','identity_key','student_no','date','sort_key','status']) THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
  IF jsonb_typeof(v)='array' THEN
   IF jsonb_array_length(v)>100 THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
   IF col='status' THEN predicate:=predicate||format(' AND data->>''status'' IN (SELECT jsonb_array_elements_text(%L::jsonb))',v::text);
   ELSIF col='week' THEN predicate:=predicate||format(' AND week IN (SELECT jsonb_array_elements_text(%L::jsonb)::integer)',v::text);
   ELSE predicate:=predicate||format(' AND %I IN (SELECT jsonb_array_elements_text(%L::jsonb))',col,v::text); END IF;
  ELSE IF col='status' THEN predicate:=predicate||format(' AND data->>''status''=%L',v#>>'{}'); ELSE predicate:=predicate||format(' AND %I=%L',col,v#>>'{}'); END IF; END IF;
 END LOOP;
 IF coalesce(p_query->>'after','')<>'' THEN predicate:=predicate||format(' AND id COLLATE "C">%L COLLATE "C"',p_query->>'after'); END IF;
 IF p_query ? 'dateFrom' THEN predicate:=predicate||format(' AND date>=%L',p_query->>'dateFrom'); END IF;
 IF p_query ? 'dateTo' THEN predicate:=predicate||format(' AND date<=%L',p_query->>'dateTo'); END IF;
 EXECUTE format('SELECT count(*) FROM xuedu_v2.%I WHERE %s',p_resource,predicate) INTO total;
 RETURN total;
END $$;
CREATE OR REPLACE FUNCTION public.xuedu_v2_commit(p_command jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb:=p_command; w xuedu_v2.workspace; ch jsonb; v jsonb; r text; stored_version bigint; prior jsonb; permissions_changed boolean:=false; initialized boolean:=coalesce((c->>'initialize')::boolean,false); actor jsonb; bound boolean; new_epoch text; duplicate_count integer; legacy_present boolean; BEGIN
 PERFORM xuedu_v2.require_server();
 IF octet_length(c::text)>2000000 OR coalesce(c->>'epoch','')='' OR coalesce(c->>'identityKey','')='' OR coalesce(c->>'requestId','')='' OR jsonb_typeof(c->'changes') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'changes')>1000 OR jsonb_typeof(c->'reads') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'reads')>5000 THEN RAISE EXCEPTION 'INVALID_COMMIT'; END IF;
 -- One row serializes membership/authorization checks and prevents concurrent last-admin removal.
 INSERT INTO xuedu_v2.workspace(id,epoch) VALUES('main','initial') ON CONFLICT(id) DO NOTHING;
 SELECT * INTO w FROM xuedu_v2.workspace WHERE id='main' FOR UPDATE;
 IF w.epoch IS DISTINCT FROM c->>'epoch' THEN RAISE EXCEPTION 'EPOCH_CHANGED'; END IF;
 SELECT data INTO prior FROM xuedu_v2.requests WHERE epoch=c->>'epoch' AND identity_key=c->>'identityKey' AND parent_id=c->>'requestId';
 IF FOUND THEN
  IF (prior->>'permissionsVersion')::bigint IS DISTINCT FROM w.permissions_version THEN RAISE EXCEPTION 'IDENTITY_CHANGED'; END IF;
  IF coalesce(prior->>'actorId','')<>'' AND NOT EXISTS(SELECT 1 FROM xuedu_v2.members m JOIN xuedu_v2.bindings b ON b.member_id=m.id WHERE m.id=prior->>'actorId' AND m.data->>'active'='true' AND m.epoch=w.epoch AND b.epoch=w.epoch AND b.identity_key=c->>'identityKey') THEN RAISE EXCEPTION 'IDENTITY_CHANGED'; END IF;
  RETURN prior->'result';
 END IF;
 IF w.version IS DISTINCT FROM (c->>'workspaceVersion')::bigint OR w.permissions_version IS DISTINCT FROM (c->>'permissionsVersion')::bigint THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 IF w.maintenance<>'' AND w.maintenance IS DISTINCT FROM c->>'maintenanceId' THEN RAISE EXCEPTION 'MAINTENANCE'; END IF;
 IF coalesce(c->>'maintenanceId','')<>'' AND w.maintenance IS DISTINCT FROM c->>'maintenanceId' THEN RAISE EXCEPTION 'MAINTENANCE_CHANGED'; END IF;
 IF initialized THEN
  IF w.version<>0 OR EXISTS(SELECT 1 FROM xuedu_v2.members) THEN RAISE EXCEPTION 'ALREADY_INITIALIZED'; END IF;
  IF to_regclass('xuedu_private.workspace') IS NOT NULL THEN
   EXECUTE 'SELECT EXISTS(SELECT 1 FROM xuedu_private.workspace WHERE jsonb_array_length(coalesce(document->''state''->''members'',''[]''::jsonb))>0)' INTO legacy_present;
   IF legacy_present THEN RAISE EXCEPTION 'CUTOVER_REQUIRED'; END IF;
  END IF;
 ELSIF coalesce(c->>'actorId','')<>'' THEN
  SELECT data INTO actor FROM xuedu_v2.members WHERE id=c->>'actorId' AND epoch=w.epoch;
  SELECT EXISTS(SELECT 1 FROM xuedu_v2.bindings WHERE identity_key=c->>'identityKey' AND member_id=c->>'actorId' AND epoch=w.epoch) INTO bound;
  IF actor IS NULL OR actor->>'active' IS DISTINCT FROM 'true' OR NOT bound THEN RAISE EXCEPTION 'IDENTITY_CHANGED'; END IF;
 ELSE
  IF c ? 'workspace' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  FOR ch IN SELECT value FROM jsonb_array_elements(c->'changes') LOOP
   IF ch->>'resource' NOT IN ('applications','rebindings') OR ch->'value'->>'identityKey' IS DISTINCT FROM c->>'identityKey' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
   EXECUTE format('SELECT identity_key FROM xuedu_v2.%I WHERE id=$1',ch->>'resource') INTO r USING ch->>'id';
   IF r IS NOT NULL AND r IS DISTINCT FROM c->>'identityKey' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  END LOOP;
 END IF;
 FOR ch IN SELECT value FROM jsonb_array_elements(c->'reads') LOOP
  r:=xuedu_v2.resource_name(ch->>'resource'); stored_version:=NULL;
  EXECUTE format('SELECT version FROM xuedu_v2.%I WHERE id=$1',r) INTO stored_version USING ch->>'id';
  IF coalesce(stored_version,0) IS DISTINCT FROM (ch->>'version')::bigint THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 END LOOP;
 SELECT count(*)-count(DISTINCT (value->>'resource',value->>'id')) INTO duplicate_count FROM jsonb_array_elements(c->'changes');
 IF duplicate_count<>0 THEN RAISE EXCEPTION 'INVALID_CHANGE'; END IF;
 new_epoch:=coalesce(c->'workspace'->>'epoch',w.epoch);
 FOR ch IN SELECT value FROM jsonb_array_elements(c->'changes') LOOP
  r:=xuedu_v2.resource_name(ch->>'resource'); v:=ch->'value'; stored_version:=NULL;
  IF (r='requests' AND (coalesce(c->>'maintenanceId','')='' OR v<>'null'::jsonb)) OR coalesce(ch->>'id','')='' OR (ch->>'expectedVersion')::bigint<0 THEN RAISE EXCEPTION 'INVALID_CHANGE'; END IF;
  EXECUTE format('SELECT version FROM xuedu_v2.%I WHERE id=$1',r) INTO stored_version USING ch->>'id';
  IF coalesce(stored_version,0) IS DISTINCT FROM (ch->>'expectedVersion')::bigint THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  permissions_changed:=permissions_changed OR r IN('members','bindings');
  IF v='null'::jsonb THEN EXECUTE format('DELETE FROM xuedu_v2.%I WHERE id=$1',r) USING ch->>'id';
  ELSE
   IF r='members' AND (jsonb_typeof(v->'data'->'active') IS DISTINCT FROM 'boolean' OR coalesce(v->'data'->>'role','') NOT IN ('admin','leader','member')) THEN RAISE EXCEPTION 'INVALID_ENTITY'; END IF;
   IF v->>'id' IS DISTINCT FROM ch->>'id' OR v->>'epoch' IS DISTINCT FROM new_epoch OR jsonb_typeof(v->'data') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_ENTITY'; END IF;
   EXECUTE format('INSERT INTO xuedu_v2.%I(id,epoch,version,data,semester_id,week,member_id,task_id,record_id,parent_id,identity_key,student_no,date,sort_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,version=excluded.version,data=excluded.data,semester_id=excluded.semester_id,week=excluded.week,member_id=excluded.member_id,task_id=excluded.task_id,record_id=excluded.record_id,parent_id=excluded.parent_id,identity_key=excluded.identity_key,student_no=excluded.student_no,date=excluded.date,sort_key=excluded.sort_key',r)
    USING v->>'id',v->>'epoch',coalesce(stored_version,0)+1,v->'data',v->>'semesterId',(v->>'week')::integer,v->>'memberId',v->>'taskId',v->>'recordId',v->>'parentId',v->>'identityKey',v->>'studentNo',v->>'date',v->>'sortKey';
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM xuedu_v2.members WHERE data->>'role'='admin' AND data->>'active'='true') THEN RAISE EXCEPTION 'LAST_ADMIN'; END IF;
 IF EXISTS(SELECT 1 FROM xuedu_v2.bindings b LEFT JOIN xuedu_v2.members m ON m.id=b.member_id WHERE m.id IS NULL) THEN RAISE EXCEPTION 'INVALID_BINDING'; END IF;
 IF EXISTS(SELECT 1 FROM xuedu_v2.members m LEFT JOIN xuedu_v2.classes cl ON cl.id=m.data->>'classId' WHERE m.data->>'role'='admin' AND cl.id IS NULL) THEN RAISE EXCEPTION 'INVALID_ADMIN_CLASS'; END IF;
 IF initialized AND NOT EXISTS(SELECT 1 FROM xuedu_v2.members m JOIN xuedu_v2.bindings b ON b.member_id=m.id WHERE m.id=c->>'actorId' AND b.identity_key=c->>'identityKey' AND m.data->>'role'='admin' AND m.data->>'active'='true') THEN RAISE EXCEPTION 'INVALID_BINDING'; END IF;
 UPDATE xuedu_v2.workspace SET epoch=new_epoch,version=w.version+1,permissions_version=w.permissions_version+CASE WHEN permissions_changed THEN 1 ELSE 0 END,active_semester_id=coalesce(c->'workspace'->>'activeSemesterId',w.active_semester_id),maintenance=coalesce(c->'workspace'->>'maintenance',w.maintenance),max_execution_ms=coalesce((c->'workspace'->>'maxExecutionMs')::integer,w.max_execution_ms) WHERE id='main';
 INSERT INTO xuedu_v2.requests(id,epoch,version,identity_key,parent_id,data) VALUES(jsonb_build_array(c->>'epoch',c->>'identityKey',c->>'requestId')::text,c->>'epoch',1,c->>'identityKey',c->>'requestId',jsonb_build_object('result',c->'result','permissionsVersion',w.permissions_version+CASE WHEN permissions_changed THEN 1 ELSE 0 END,'actorId',c->>'actorId'));
 RETURN c->'result';
END $$;
-- Controlled cutover manifest contains only the fixed retained objects; no history aggregate.
CREATE TABLE IF NOT EXISTS xuedu_v2.cutover_manifest(id text PRIMARY KEY, digest text NOT NULL, plan jsonb NOT NULL, opened boolean NOT NULL DEFAULT false);
ALTER TABLE xuedu_v2.cutover_manifest ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON xuedu_v2.cutover_manifest FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.xuedu_v2_cutover_prepare(p_plan jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb:=p_plan; old_doc jsonb; old_rev bigint; r text; e jsonb; expected jsonb; n integer; w jsonb; occupied boolean; BEGIN
 PERFORM xuedu_v2.require_server();
 IF p->>'format' IS DISTINCT FROM 'xuedu-v2-cutover-1' OR p->>'sha256' !~ '^[a-f0-9]{64}$' OR p->'source'->>'sha256' !~ '^[a-f0-9]{64}$' OR p->>'id' NOT LIKE 'cutover-%' THEN RAISE EXCEPTION 'INVALID_CUTOVER'; END IF;
 IF p->'target'->>'environmentId' IS DISTINCT FROM 'xuedu-trial-d2gs2dpnla9206eb3' OR p->'target'->>'functionName' IS DISTINCT FROM 'xueduTrial' THEN RAISE EXCEPTION 'INVALID_CUTOVER_TARGET'; END IF;
 IF to_regclass('xuedu_private.workspace') IS NULL THEN RAISE EXCEPTION 'CUTOVER_SOURCE_MISSING'; END IF;
 EXECUTE 'SELECT document,revision FROM xuedu_private.workspace WHERE stage=$1 FOR UPDATE' INTO old_doc,old_rev USING p->'source'->>'stage';
 IF old_doc IS NULL OR old_rev IS DISTINCT FROM (p->'source'->>'revision')::bigint OR old_doc->>'epoch' IS DISTINCT FROM p->'source'->>'epoch' OR old_doc->>'version' IS DISTINCT FROM p->'source'->>'version' THEN RAISE EXCEPTION 'CUTOVER_SOURCE_CHANGED'; END IF;
 IF coalesce((old_doc->>'cleaning')::boolean,false) OR (old_doc->'resetAll' IS NOT NULL AND old_doc->'resetAll'<>'null'::jsonb) OR (old_doc->'businessClear' IS NOT NULL AND old_doc->'businessClear'<>'null'::jsonb) THEN RAISE EXCEPTION 'LEGACY_MAINTENANCE_PENDING'; END IF;
 INSERT INTO xuedu_v2.workspace(id,epoch) VALUES('main','initial') ON CONFLICT(id) DO NOTHING;
 PERFORM 1 FROM xuedu_v2.workspace WHERE id='main' FOR UPDATE;
 IF EXISTS(SELECT 1 FROM xuedu_v2.cutover_manifest WHERE id=p->>'id' AND digest=p->>'sha256') THEN RETURN public.xuedu_v2_workspace(); END IF;
 IF EXISTS(SELECT 1 FROM xuedu_v2.workspace WHERE version<>0) THEN RAISE EXCEPTION 'ALREADY_INITIALIZED'; END IF;
 FOREACH r IN ARRAY ARRAY['members','bindings','applications','classes','semesters','semester_classes','courses','course_versions','occurrences','exceptions','availability','plans','tasks','records','record_versions','photos','audit','requests','maintenance','rebindings'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM xuedu_v2.%I)',r) INTO occupied;
  IF occupied THEN RAISE EXCEPTION 'CUTOVER_TARGET_NOT_EMPTY'; END IF;
 END LOOP;
 w:=p->'workspace';
 IF w->>'id' IS DISTINCT FROM 'main' OR w->>'maintenance' IS DISTINCT FROM p->>'id' OR w->>'epoch'=old_doc->>'epoch' OR coalesce(w->>'epoch','')='' OR w->>'version' IS DISTINCT FROM '1' OR w->>'permissionsVersion' IS DISTINCT FROM '1' OR w->>'protocolVersion' IS DISTINCT FROM '2' OR w->>'activeSemesterId' IS DISTINCT FROM '' OR (w->>'maxExecutionMs')::integer<1000 OR (w->>'maxExecutionMs')::integer>900000 THEN RAISE EXCEPTION 'INVALID_CUTOVER'; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(old_doc->'state'->'members') m WHERE m->>'role'='admin';
 IF n=0 OR n<>jsonb_array_length(p->'retained'->'members') OR n<>jsonb_array_length(p->'retained'->'bindings') THEN RAISE EXCEPTION 'CUTOVER_ADMIN_MISMATCH'; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p->'retained'->'members') LOOP
  SELECT value INTO expected FROM jsonb_array_elements(old_doc->'state'->'members') WHERE value->>'id'=e->>'id' AND value->>'role'='admin';
  IF expected IS NULL OR e->'data' IS DISTINCT FROM expected-'identityKey' OR e->>'studentNo' IS DISTINCT FROM expected->>'studentNo' OR e->>'epoch' IS DISTINCT FROM w->>'epoch' OR e->>'version' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'CUTOVER_ADMIN_MISMATCH'; END IF;
  INSERT INTO xuedu_v2.members(id,epoch,version,data,student_no) VALUES(e->>'id',e->>'epoch',1,e->'data',e->>'studentNo');
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(p->'retained'->'bindings') LOOP
  SELECT value INTO expected FROM jsonb_array_elements(old_doc->'state'->'members') WHERE value->>'id'=e->>'memberId' AND value->>'role'='admin';
  IF expected IS NULL OR e->>'identityKey' IS DISTINCT FROM expected->>'identityKey' OR coalesce(e->>'identityKey','')='' OR e->>'identityKey'='self' OR e->>'epoch' IS DISTINCT FROM w->>'epoch' OR e->>'version' IS DISTINCT FROM '1' OR e->'data' IS DISTINCT FROM jsonb_build_object('memberId',e->>'memberId','active',expected->'active') THEN RAISE EXCEPTION 'CUTOVER_BINDING_MISMATCH'; END IF;
  INSERT INTO xuedu_v2.bindings(id,epoch,version,data,member_id,identity_key) VALUES(e->>'id',e->>'epoch',1,e->'data',e->>'memberId',e->>'identityKey');
 END LOOP;
 SELECT count(DISTINCT data->>'classId') INTO n FROM xuedu_v2.members;
 IF n<>jsonb_array_length(p->'retained'->'classes') THEN RAISE EXCEPTION 'CUTOVER_CLASS_MISMATCH'; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p->'retained'->'classes') LOOP
  SELECT value INTO expected FROM jsonb_array_elements(old_doc->'state'->'classes') WHERE value->>'id'=e->>'id';
  IF expected IS NULL OR e->'data' IS DISTINCT FROM expected OR e->>'epoch' IS DISTINCT FROM w->>'epoch' OR e->>'version' IS DISTINCT FROM '1' OR NOT EXISTS(SELECT 1 FROM xuedu_v2.members WHERE data->>'classId'=e->>'id') THEN RAISE EXCEPTION 'CUTOVER_CLASS_MISMATCH'; END IF;
  INSERT INTO xuedu_v2.classes(id,epoch,version,data) VALUES(e->>'id',e->>'epoch',1,e->'data');
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM xuedu_v2.members WHERE data->>'active'='true') OR EXISTS(SELECT 1 FROM xuedu_v2.members m LEFT JOIN xuedu_v2.classes c ON c.id=m.data->>'classId' WHERE c.id IS NULL) THEN RAISE EXCEPTION 'CUTOVER_ADMIN_CLASS_REQUIRED'; END IF;
 UPDATE xuedu_v2.workspace SET epoch=w->>'epoch',version=1,permissions_version=1,maintenance=p->>'id',max_execution_ms=(w->>'maxExecutionMs')::integer WHERE id='main';
 INSERT INTO xuedu_v2.cutover_manifest(id,digest,plan) VALUES(p->>'id',p->>'sha256',p);
 RETURN public.xuedu_v2_workspace();
END $$;
CREATE OR REPLACE FUNCTION public.xuedu_v2_cutover_open(p_epoch text,p_version bigint,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w xuedu_v2.workspace; manifest jsonb; r text; actual jsonb; expected jsonb; occupied boolean; BEGIN
 PERFORM xuedu_v2.require_server();
 SELECT * INTO w FROM xuedu_v2.workspace WHERE id='main' FOR UPDATE;
 IF w.epoch IS DISTINCT FROM p_epoch OR w.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 SELECT plan INTO manifest FROM xuedu_v2.cutover_manifest WHERE id=w.maintenance AND digest=p_digest AND NOT opened;
 IF manifest IS NULL THEN RAISE EXCEPTION 'CUTOVER_MANIFEST_MISMATCH'; END IF;
 FOREACH r IN ARRAY ARRAY['members','bindings','classes'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(xuedu_v2.entity(to_jsonb(t)) ORDER BY id COLLATE "C"),''[]''::jsonb) FROM xuedu_v2.%I t',r) INTO actual;
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'id' COLLATE "C"),'[]'::jsonb) INTO expected FROM jsonb_array_elements(manifest->'retained'->r);
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CUTOVER_RETENTION_CHANGED'; END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['applications','semesters','semester_classes','courses','course_versions','occurrences','exceptions','availability','plans','tasks','records','record_versions','photos','audit','requests','maintenance','rebindings'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM xuedu_v2.%I)',r) INTO occupied;
  IF occupied THEN RAISE EXCEPTION 'CUTOVER_UNEXPECTED_DATA'; END IF;
 END LOOP;
 UPDATE xuedu_v2.cutover_manifest SET opened=true WHERE id=w.maintenance;
 UPDATE xuedu_v2.workspace SET maintenance='',version=version+1 WHERE id='main';
 RETURN public.xuedu_v2_workspace();
END $$;
REVOKE ALL ON FUNCTION public.xuedu_v2_cutover_prepare(jsonb),public.xuedu_v2_cutover_open(text,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.xuedu_v2_cutover_prepare(jsonb),public.xuedu_v2_cutover_open(text,bigint,text) TO service_role;

-- No V1 client may reopen or write the old aggregate after V2 migration.
CREATE OR REPLACE FUNCTION public.xuedu_read_workspace(p_stage text,p_initial jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'UPDATE_REQUIRED'; END $$;
CREATE OR REPLACE FUNCTION public.xuedu_commit_workspace(p_stage text,p_revision bigint,p_document jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'UPDATE_REQUIRED'; END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA xuedu_v2 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.xuedu_v2_workspace(),public.xuedu_v2_query(text,jsonb),public.xuedu_v2_count(text,jsonb),public.xuedu_v2_commit(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.xuedu_v2_workspace(),public.xuedu_v2_query(text,jsonb),public.xuedu_v2_count(text,jsonb),public.xuedu_v2_commit(jsonb) TO service_role;
COMMIT;
