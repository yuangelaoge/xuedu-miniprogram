-- Bound server-only read pages and remove superseded scheduling history from
-- the calculation read set. No business rows, entity fields or grants are changed.
-- Apply after 012. This migration is safe to replay; clients keep existing cursors.
BEGIN;
CREATE OR REPLACE FUNCTION public.xuedu_v2_query(p_resource text,p_query jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer:=coalesce((p_query->>'limit')::integer,50); k text; v jsonb; col text; predicate text:='TRUE'; sql text; rows jsonb; cnt integer; item jsonb; bounded jsonb:='[]'::jsonb; emitted integer:=0; used_bytes integer:=2; item_bytes integer; BEGIN
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
 -- Row count alone does not bound a page: six legal 5000-character Chinese
 -- observation fields can make one record about 90 KiB. Keep whole entities,
 -- and use the last emitted ID as the cursor whenever byte/count limits stop us.
 -- JSONB text includes whitespace, so this is conservative for wire JSON bytes.
 FOR item IN SELECT value FROM jsonb_array_elements(rows) WITH ORDINALITY AS entries(value,ord) ORDER BY ord LOOP
  EXIT WHEN emitted>=n;
  item_bytes:=octet_length(item::text)+CASE WHEN emitted=0 THEN 0 ELSE 1 END;
  EXIT WHEN emitted>0 AND used_bytes+item_bytes>393216;
  bounded:=bounded || jsonb_build_array(item);
  emitted:=emitted+1; used_bytes:=used_bytes+item_bytes;
 END LOOP;
 RETURN jsonb_build_object('items',bounded,'cursor',CASE WHEN cnt>emitted THEN bounded->(emitted-1)->>'id' ELSE '' END);
END $$;
REVOKE ALL ON FUNCTION public.xuedu_v2_query(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.xuedu_v2_query(text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.xuedu_v2_scheduling_read(p_identity_key text, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 w jsonb; ep text; binding jsonb; actor jsonb; sem jsonb; receipt jsonb;
 kind text:=p_request->>'kind'; sid text:=p_request->>'semesterId'; wk integer;
 result jsonb; rows jsonb; items jsonb; r text; predicate text; total integer:=0; n integer;
BEGIN
 PERFORM xuedu_v2.require_server();
 IF coalesce(p_identity_key,'')='' OR length(p_identity_key)>200
    OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR octet_length(p_request::text)>10000
    OR kind IS NULL OR kind NOT IN ('members','planGenerate','taskAdjust','planConfirm','scheduleReport') THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 -- All business commits lock this row FOR UPDATE. A shared lock keeps identity,
 -- permissions and every scoped read consistent, without waiting behind a write.
 PERFORM 1 FROM xuedu_v2.workspace WHERE id='main' FOR SHARE NOWAIT;
 w:=public.xuedu_v2_workspace(); ep:=w->>'epoch';
 IF p_request->>'epoch' IS DISTINCT FROM ep THEN RAISE EXCEPTION 'EPOCH_CHANGED'; END IF;
 SELECT xuedu_v2.entity(to_jsonb(b)), xuedu_v2.entity(to_jsonb(m)) INTO binding,actor
 FROM xuedu_v2.bindings b JOIN xuedu_v2.members m ON m.id=b.member_id AND m.epoch=ep
 WHERE b.epoch=ep AND b.identity_key=p_identity_key;
 IF actor IS NULL OR actor->'data'->'active' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 rows:=jsonb_build_object('bindings',jsonb_build_array(binding),'members',jsonb_build_array(actor));
 result:=jsonb_build_object('workspace',w);
 -- A receipt must precede mutable/role checks, just as in gateway.ts. The live
 -- binding and permissions fence still apply, including after role revocation.
 IF kind IN ('planGenerate','taskAdjust','planConfirm') AND coalesce(p_request->>'requestId','')<>'' THEN
  SELECT xuedu_v2.entity(to_jsonb(t)) INTO receipt FROM xuedu_v2.requests t
    WHERE t.epoch=ep AND t.identity_key=p_identity_key AND t.parent_id=p_request->>'requestId' LIMIT 1;
 END IF;
 rows:=rows || jsonb_build_object('requests',CASE WHEN receipt IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(receipt) END);
 IF receipt IS NOT NULL THEN
  IF receipt->'data'->'permissionsVersion' IS DISTINCT FROM w->'permissionsVersion' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  RETURN result || jsonb_build_object('rows',rows);
 END IF;
 IF kind='members' THEN
  IF coalesce(actor->'data'->>'role','') NOT IN ('admin','leader') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_request ? 'version' AND p_request->'version' IS DISTINCT FROM w->'version' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  IF p_request ? 'limit' AND (jsonb_typeof(p_request->'limit') IS DISTINCT FROM 'number'
     OR (p_request->>'limit')::numeric<>trunc((p_request->>'limit')::numeric)
     OR (p_request->>'limit')::numeric NOT BETWEEN 1 AND 100) THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
  IF p_request ? 'cursor' AND (jsonb_typeof(p_request->'cursor') IS DISTINCT FROM 'string'
     OR length(p_request->>'cursor')>256) THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
  n:=coalesce((p_request->>'limit')::integer,50);
  items:=public.xuedu_v2_query('members',jsonb_build_object('eq',jsonb_build_object('epoch',ep),'limit',n,'after',coalesce(p_request->>'cursor','')));
  RETURN result || jsonb_build_object('rows',rows,'memberPage',items);
 END IF;
 IF kind IN ('taskAdjust','planConfirm') AND actor->'data'->>'role' IS DISTINCT FROM 'admin'
    OR kind IN ('planGenerate','scheduleReport') AND coalesce(actor->'data'->>'role','') NOT IN ('admin','officer') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF w->>'maintenance'<>'' THEN RAISE EXCEPTION 'MAINTENANCE'; END IF;
 IF kind='planConfirm' THEN
  IF jsonb_typeof(p_request->'id') IS DISTINCT FROM 'string' OR length(p_request->>'id')>200 THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
  SELECT p.week INTO wk FROM xuedu_v2.plans p WHERE p.epoch=ep AND p.semester_id=sid AND p.id=p_request->>'id' AND p.data->>'status'='draft';
  IF wk IS NULL THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
  p_request:=jsonb_set(p_request,'{week}',to_jsonb(wk));
 END IF;
 IF coalesce(sid,'')='' OR length(sid)>200 OR jsonb_typeof(p_request->'week') IS DISTINCT FROM 'number'
    OR (p_request->>'week')::numeric<>trunc((p_request->>'week')::numeric)
    OR (p_request->>'week')::numeric NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 wk:=(p_request->>'week')::integer;
 SELECT xuedu_v2.entity(to_jsonb(s)) INTO sem FROM xuedu_v2.semesters s WHERE s.epoch=ep AND s.id=sid;
 IF sem IS NULL OR wk>(sem->'data'->>'weeks')::integer THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 rows:=rows || jsonb_build_object('semesters',jsonb_build_array(sem));
 -- Bounded internal read set, distinct from the unchanged 50/100-row client pages.
 -- Never silently truncate: 5000 is also the transaction read-version limit.
 FOREACH r IN ARRAY ARRAY['members','semester_classes','classes','plans','tasks','occurrences','availability','records'] LOOP
  IF kind='scheduleReport' AND r NOT IN ('members','plans','tasks') THEN CONTINUE; END IF;
  predicate:=format('t.epoch=%L',ep);
  IF kind='scheduleReport' AND r='members' THEN
   predicate:=predicate || format(' AND (t.data->>''active''=''true'' OR EXISTS (SELECT 1 FROM xuedu_v2.tasks assigned WHERE assigned.epoch=%L AND assigned.semester_id=%L AND assigned.week=%s AND assigned.member_id=t.id AND assigned.data->>''status'' IN (''confirmed'',''submitted'')))',ep,sid,wk);
  END IF;
  IF r='classes' THEN
   predicate:=predicate || format(' AND EXISTS (SELECT 1 FROM xuedu_v2.semester_classes sc WHERE sc.epoch=%L AND sc.semester_id=%L AND sc.parent_id=t.id)',ep,sid);
  ELSIF r<>'members' THEN
   predicate:=predicate || format(' AND t.semester_id=%L',sid);
   IF r='records' THEN predicate:=predicate || format(' AND t.week IN (%s,%s)',wk,greatest(1,wk-1));
   ELSIF r<>'semester_classes' THEN predicate:=predicate || format(' AND t.week=%s',wk); END IF;
  END IF;
  -- Scheduling only mutates effective tasks and current draft tasks. Preserve
  -- submitted tasks, pending adjustments and cancel=true drafts; their records,
  -- old task references and permissions still receive the existing checks.
  -- Receipts above remain available before any status/read-set filtering.
  IF r='tasks' THEN
   predicate:=predicate || ' AND t.data->>''status'' IN (''confirmed'',''submitted'',''pendingAdjustment'',''draft'')';
  ELSIF r='plans' THEN
   predicate:=predicate || ' AND t.data->>''status'' IN (''confirmed'',''skipped'',''draft'')';
  END IF;
  EXECUTE format('SELECT coalesce(jsonb_agg(xuedu_v2.entity(to_jsonb(t)) ORDER BY t.id COLLATE "C"),''[]''::jsonb) FROM (SELECT * FROM xuedu_v2.%I t WHERE %s ORDER BY t.id COLLATE "C" LIMIT 5001) t',r,predicate) INTO items;
  total:=total+jsonb_array_length(items);
  IF total>4996 THEN RAISE EXCEPTION 'SCHEDULING_LIMIT'; END IF;
  rows:=rows || jsonb_build_object(r,items);
 END LOOP;
 IF octet_length(rows::text)>8000000 THEN RAISE EXCEPTION 'SCHEDULING_LIMIT'; END IF;
 RETURN result || jsonb_build_object('rows',rows);
END $$;
REVOKE ALL ON FUNCTION public.xuedu_v2_scheduling_read(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.xuedu_v2_scheduling_read(text,jsonb) TO service_role;
COMMIT;
