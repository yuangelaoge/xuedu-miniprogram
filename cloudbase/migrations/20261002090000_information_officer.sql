-- Requires 003/004/005/006. No role assignments or business rows are changed.
BEGIN;
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
 ELSIF coalesce((c->>'autoJoin')::boolean,false) THEN
  PERFORM xuedu_v2.validate_auto_join(c,w);
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
 IF c->'workspace' ? 'autoApproval' THEN
  IF actor->>'role' IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  v:=c->'workspace'->'autoApproval';
  IF v<>'null'::jsonb AND (jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean' OR v->>'updatedBy' IS DISTINCT FROM c->>'actorId' OR (v->>'enabled'='true' AND (NOT isfinite((v->>'expiresAt')::timestamptz) OR (v->>'expiresAt')::timestamptz IS NULL OR (v->>'expiresAt')::timestamptz<=clock_timestamp()))) THEN RAISE EXCEPTION 'INVALID_CHANGE'; END IF;
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
   IF r='members' AND (jsonb_typeof(v->'data'->'active') IS DISTINCT FROM 'boolean' OR coalesce(v->'data'->>'role','') NOT IN ('admin','leader','member','officer')) THEN RAISE EXCEPTION 'INVALID_ENTITY'; END IF;
   IF v->>'id' IS DISTINCT FROM ch->>'id' OR v->>'epoch' IS DISTINCT FROM new_epoch OR jsonb_typeof(v->'data') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_ENTITY'; END IF;
   EXECUTE format('INSERT INTO xuedu_v2.%I(id,epoch,version,data,semester_id,week,member_id,task_id,record_id,parent_id,identity_key,student_no,date,sort_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,version=excluded.version,data=excluded.data,semester_id=excluded.semester_id,week=excluded.week,member_id=excluded.member_id,task_id=excluded.task_id,record_id=excluded.record_id,parent_id=excluded.parent_id,identity_key=excluded.identity_key,student_no=excluded.student_no,date=excluded.date,sort_key=excluded.sort_key',r)
    USING v->>'id',v->>'epoch',coalesce(stored_version,0)+1,v->'data',v->>'semesterId',(v->>'week')::integer,v->>'memberId',v->>'taskId',v->>'recordId',v->>'parentId',v->>'identityKey',v->>'studentNo',v->>'date',v->>'sortKey';
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM xuedu_v2.members WHERE data->>'role'='admin' AND data->>'active'='true') THEN RAISE EXCEPTION 'LAST_ADMIN'; END IF;
 IF EXISTS(SELECT 1 FROM xuedu_v2.bindings b LEFT JOIN xuedu_v2.members m ON m.id=b.member_id WHERE m.id IS NULL) THEN RAISE EXCEPTION 'INVALID_BINDING'; END IF;
 IF EXISTS(SELECT 1 FROM xuedu_v2.members m LEFT JOIN xuedu_v2.classes cl ON cl.id=m.data->>'classId' WHERE m.data->>'role'='admin' AND cl.id IS NULL) THEN RAISE EXCEPTION 'INVALID_ADMIN_CLASS'; END IF;
 IF initialized AND NOT EXISTS(SELECT 1 FROM xuedu_v2.members m JOIN xuedu_v2.bindings b ON b.member_id=m.id WHERE m.id=c->>'actorId' AND b.identity_key=c->>'identityKey' AND m.data->>'role'='admin' AND m.data->>'active'='true') THEN RAISE EXCEPTION 'INVALID_BINDING'; END IF;
 IF coalesce((c->>'autoJoin')::boolean,false) AND (w.auto_approval->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'AUTO_APPROVAL_EXPIRED'; END IF;
 UPDATE xuedu_v2.workspace SET epoch=new_epoch,version=w.version+1,permissions_version=w.permissions_version+CASE WHEN permissions_changed THEN 1 ELSE 0 END,active_semester_id=coalesce(c->'workspace'->>'activeSemesterId',w.active_semester_id),maintenance=coalesce(c->'workspace'->>'maintenance',w.maintenance),max_execution_ms=coalesce((c->'workspace'->>'maxExecutionMs')::integer,w.max_execution_ms),auto_approval=CASE WHEN c->'workspace' ? 'autoApproval' THEN nullif(c->'workspace'->'autoApproval','null'::jsonb) ELSE w.auto_approval END WHERE id='main';
 INSERT INTO xuedu_v2.requests(id,epoch,version,identity_key,parent_id,data) VALUES(jsonb_build_array(c->>'epoch',c->>'identityKey',c->>'requestId')::text,c->>'epoch',1,c->>'identityKey',c->>'requestId',jsonb_build_object('result',c->'result','permissionsVersion',w.permissions_version+CASE WHEN permissions_changed THEN 1 ELSE 0 END,'actorId',c->>'actorId'));
 RETURN c->'result';
END $$;
ALTER TABLE xuedu_review.sessions DROP CONSTRAINT sessions_role_check;
ALTER TABLE xuedu_review.sessions ADD CONSTRAINT sessions_role_check CHECK(role IN ('admin','leader','member','officer','applicant'));
CREATE OR REPLACE FUNCTION public.xuedu_review_role(p_digest text,p_expected_version bigint,p_role text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v bigint; BEGIN
  PERFORM xuedu_v2.require_server();
  IF p_role NOT IN ('admin','leader','member','officer','applicant') OR p_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_REVIEW_REQUEST'; END IF;
  UPDATE xuedu_review.sessions SET role=p_role,version=version+1,updated_at=clock_timestamp()
   WHERE digest=p_digest AND version=p_expected_version AND expires_at>clock_timestamp() AND snapshot IS NOT NULL RETURNING version INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'REVIEW_VERSION_CONFLICT'; END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.xuedu_v2_commit(jsonb),public.xuedu_review_role(text,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.xuedu_v2_commit(jsonb),public.xuedu_review_role(text,bigint,text) TO service_role;
COMMIT;
