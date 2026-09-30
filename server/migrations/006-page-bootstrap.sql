-- Page reads use one server-only RPC. Apply after 003/004; no business rows are changed.
BEGIN;
CREATE OR REPLACE FUNCTION xuedu_v2.page_entity(e jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT (e-'identityKey') || jsonb_build_object('data',coalesce(e->'data','{}'::jsonb)-'identityKey');
$$;
CREATE OR REPLACE FUNCTION xuedu_v2.page_list(r text,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p jsonb; BEGIN
 p:=public.xuedu_v2_query(r,q);
 RETURN jsonb_build_object('items',coalesce((SELECT jsonb_agg(xuedu_v2.page_entity(value) ORDER BY ord)
   FROM jsonb_array_elements(p->'items') WITH ORDINALITY AS t(value,ord)),'[]'::jsonb),'cursor',p->'cursor');
END $$;
CREATE OR REPLACE FUNCTION public.xuedu_v2_bootstrap_page(p_identity_key text,p_request jsonb,p_can_initialize boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 w jsonb; a jsonb; app jsonb; sem jsonb; selected text; ep text; aid text; manager boolean;
 req jsonb:=coalesce(p_request->'page','{}'::jsonb); view_name text; more_rows boolean;
 nweek integer:=1; maxweek integer:=60; current_week integer:=1; removed boolean:=false;
 result jsonb; page_data jsonb; week_data jsonb; tasks jsonb; records jsonb; plan jsonb; draft jsonb; available jsonb;
 filter jsonb; visible_filter jsonb; total bigint; submitted bigint; coverage bigint; class_name text;
BEGIN
 PERFORM xuedu_v2.require_server();
 IF coalesce(p_identity_key,'')='' OR length(p_identity_key)>200 OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR octet_length(p_request::text)>10000 OR jsonb_typeof(req) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 view_name:=CASE WHEN p_request->'includeHome'='true'::jsonb THEN 'home' ELSE req->>'view' END;
 IF view_name IS NULL OR view_name NOT IN ('home','schedule','records','profile','courses','availability')
    OR (view_name='home' AND p_request ? 'page') THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 IF req ? 'more' AND jsonb_typeof(req->'more') IS DISTINCT FROM 'boolean'
    OR req ? 'cursor' AND (jsonb_typeof(req->'cursor') IS DISTINCT FROM 'string' OR length(req->>'cursor')>256)
    OR req ? 'semesterId' AND (jsonb_typeof(req->'semesterId') IS DISTINCT FROM 'string' OR length(req->>'semesterId')>200)
    OR req ? 'selectionOwner' AND (jsonb_typeof(req->'selectionOwner') IS DISTINCT FROM 'string' OR length(req->>'selectionOwner')>200)
    THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 more_rows:=coalesce((req->>'more')::boolean,false);
 IF more_rows AND view_name NOT IN ('records','courses') THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 IF req ? 'week' THEN
  IF jsonb_typeof(req->'week') IS DISTINCT FROM 'number' OR (req->>'week')::numeric<>trunc((req->>'week')::numeric)
     OR (req->>'week')::numeric NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 END IF;
 -- Every V2 write locks this row FOR UPDATE. Holding SHARE through this transaction
 -- replaces repeated network permission checks; NOWAIT avoids queuing behind a write.
 PERFORM 1 FROM xuedu_v2.workspace WHERE id='main' FOR SHARE NOWAIT;
 w:=public.xuedu_v2_workspace(); ep:=w->>'epoch';
 SELECT xuedu_v2.page_entity(xuedu_v2.entity(to_jsonb(m))) INTO a
 FROM xuedu_v2.bindings b JOIN xuedu_v2.members m ON m.id=b.member_id AND m.epoch=ep
 WHERE b.identity_key=p_identity_key AND b.epoch=ep;
 removed:=a IS NOT NULL AND a->'data'->'active' IS DISTINCT FROM 'true'::jsonb;
 IF removed THEN a:=NULL; END IF;
 aid:=a->>'id'; manager:=coalesce(a->'data'->>'role' IN ('admin','leader'),false);
 IF a IS NULL THEN
  SELECT xuedu_v2.page_entity(xuedu_v2.entity(to_jsonb(t))) INTO app
  FROM xuedu_v2.applications t WHERE t.epoch=ep AND t.identity_key=p_identity_key;
 END IF;
 IF a->'data'->>'role' IS DISTINCT FROM 'admin' THEN w:=w-'autoApproval'; END IF;
 result:=jsonb_build_object('workspace',w,'member',a,'application',app,'removed',removed,
   'status',CASE WHEN (w->>'version')::bigint=0 THEN 'needsAdministrator' WHEN w->>'activeSemesterId'='' THEN 'preparing' ELSE 'ready' END,
   'canInitialize',(w->>'version')::bigint=0 AND coalesce(p_can_initialize,false),'readPath','single-rpc');
 IF more_rows AND p_request->>'epoch' IS DISTINCT FROM ep THEN RAISE EXCEPTION 'EPOCH_CHANGED'; END IF;
 IF a IS NULL OR w->>'maintenance'<>'' OR (view_name<>'home' AND coalesce(p_request->>'epoch','')<>'' AND p_request->>'epoch'<>ep) THEN
  result:=result || CASE WHEN view_name='home' THEN jsonb_build_object('home',jsonb_build_object('semester',NULL,'week',1,'weekData',NULL)) ELSE jsonb_build_object('page',NULL) END;
 ELSE
  IF more_rows AND coalesce(req->>'selectionOwner','')<>'' AND req->>'selectionOwner'<>aid THEN RAISE EXCEPTION 'IDENTITY_CHANGED'; END IF;
  selected:=CASE WHEN view_name IN ('home','profile') OR coalesce(req->>'selectionOwner','')<>'' AND req->>'selectionOwner'<>aid
    THEN w->>'activeSemesterId' ELSE coalesce(nullif(req->>'semesterId',''),w->>'activeSemesterId') END;
  IF selected<>'' THEN
   SELECT xuedu_v2.page_entity(xuedu_v2.entity(to_jsonb(s))) INTO sem FROM xuedu_v2.semesters s WHERE s.id=selected AND s.epoch=ep;
   IF sem IS NULL THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
   maxweek:=(sem->'data'->>'weeks')::integer;
   current_week:=least(maxweek,greatest(1,floor(((current_timestamp AT TIME ZONE 'Asia/Shanghai')::date-(sem->'data'->>'startDate')::date)/7.0)::integer+1));
  END IF;
  nweek:=least(maxweek,coalesce((req->>'week')::numeric::integer,CASE WHEN selected=w->>'activeSemesterId' THEN current_week+CASE WHEN view_name IN ('schedule','availability') THEN 1 ELSE 0 END ELSE 1 END));
  page_data:=jsonb_build_object('semester',sem,'week',nweek);
  IF view_name<>'home' AND NOT more_rows THEN
   page_data:=page_data || jsonb_build_object('semesters',CASE WHEN view_name IN ('schedule','records','courses')
     THEN xuedu_v2.page_list('semesters',jsonb_build_object('eq',jsonb_build_object('epoch',ep)))
     ELSE jsonb_build_object('items',CASE WHEN sem IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(sem) END,'cursor','') END);
  END IF;
  filter:=jsonb_build_object('epoch',ep,'semesterId',selected,'week',nweek);
  visible_filter:=filter || CASE WHEN manager THEN '{}'::jsonb ELSE jsonb_build_object('memberId',aid) END;
  IF view_name='profile' THEN
   SELECT c.data->>'name' INTO class_name FROM xuedu_v2.classes c WHERE c.id=a->'data'->>'classId' AND c.epoch=ep;
   SELECT count(*) INTO total FROM xuedu_v2.applications t WHERE manager AND t.epoch=ep AND t.data->>'status'='pending';
   page_data:=page_data || jsonb_build_object('profile',jsonb_build_object('className',coalesce(class_name,'班级未设置'),'pendingCount',total));
  END IF;
  IF view_name IN ('courses','records') THEN
   page_data:=page_data || jsonb_build_object('list',CASE WHEN sem IS NULL THEN jsonb_build_object('items','[]'::jsonb,'cursor','')
     ELSE xuedu_v2.page_list(view_name,jsonb_build_object('eq',CASE WHEN view_name='courses' THEN filter-'week' ELSE visible_filter END,'after',coalesce(req->>'cursor',''))) END);
   IF view_name='courses' AND NOT more_rows THEN
    page_data:=page_data || jsonb_build_object('classes',xuedu_v2.page_list('classes',jsonb_build_object('eq',jsonb_build_object('epoch',ep))));
   END IF;
  END IF;
  IF sem IS NOT NULL AND NOT more_rows THEN
   IF view_name IN ('home','schedule','records') THEN
    SELECT xuedu_v2.page_entity(xuedu_v2.entity(to_jsonb(p))) INTO plan FROM xuedu_v2.plans p
     WHERE p.epoch=ep AND p.semester_id=selected AND p.week=nweek AND p.data->>'status' IN ('confirmed','skipped') ORDER BY p.id COLLATE "C" DESC LIMIT 1;
   END IF;
   IF view_name IN ('home','records') THEN
    SELECT count(*) INTO total FROM xuedu_v2.tasks t WHERE t.epoch=ep AND t.semester_id=selected AND t.week=nweek
      AND (manager OR t.member_id=aid) AND t.data->>'status' IN ('confirmed','submitted','pendingAdjustment');
    SELECT count(*),count(DISTINCT coalesce(r.data->>'classLabel','')) INTO submitted,coverage FROM xuedu_v2.records r
      WHERE r.epoch=ep AND r.semester_id=selected AND r.week=nweek AND (manager OR r.member_id=aid);
    IF view_name='records' THEN
     page_data:=page_data || jsonb_build_object('summary',jsonb_build_object('total',total,'submitted',submitted,'skipped',coalesce(plan->'data'->>'status'='skipped',false)));
    END IF;
   END IF;
   IF view_name IN ('home','availability') THEN
    SELECT xuedu_v2.page_entity(xuedu_v2.entity(to_jsonb(av))) INTO available FROM xuedu_v2.availability av
      WHERE av.epoch=ep AND av.semester_id=selected AND av.week=nweek AND av.member_id=aid LIMIT 1;
   END IF;
   IF view_name IN ('home','schedule','availability') THEN
    tasks:='[]'::jsonb;
    IF view_name IN ('home','schedule') THEN
     SELECT coalesce(jsonb_agg(xuedu_v2.page_entity(xuedu_v2.entity(to_jsonb(t))) ORDER BY t.id COLLATE "C"),'[]'::jsonb) INTO tasks
       FROM xuedu_v2.tasks t WHERE t.epoch=ep AND t.semester_id=selected AND t.week=nweek
       AND (view_name='schedule' AND manager OR t.member_id=aid)
       AND (view_name<>'home' OR t.data->>'status' IN ('confirmed','submitted','pendingAdjustment'));
    END IF;
    week_data:=jsonb_build_object('semester',sem,'tasks',tasks,'occurrences','[]'::jsonb);
    IF view_name IN ('home','availability') THEN week_data:=week_data || jsonb_build_object('availability',available); END IF;
    IF plan IS NOT NULL THEN week_data:=week_data || jsonb_build_object('plan',plan); END IF;
    IF view_name='schedule' THEN
     SELECT xuedu_v2.page_entity(xuedu_v2.entity(to_jsonb(p))) INTO draft FROM xuedu_v2.plans p
       WHERE p.epoch=ep AND p.semester_id=selected AND p.week=nweek AND p.data->>'status'='draft' ORDER BY p.id COLLATE "C" LIMIT 1;
     week_data:=week_data || jsonb_build_object('uncovered',coalesce(draft->'data'->'uncovered','[]'::jsonb));
     IF draft IS NOT NULL THEN week_data:=week_data || jsonb_build_object('draft',draft); END IF;
    ELSIF view_name='home' THEN
     -- Home needs links, not observation forms, names or photo metadata for every member.
     SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'epoch',r.epoch,'version',r.version,'taskId',r.task_id,'memberId',r.member_id,
       'data',jsonb_build_object('classLabel',r.data->>'classLabel')) ORDER BY r.id COLLATE "C"),'[]'::jsonb) INTO records
       FROM xuedu_v2.records r WHERE r.epoch=ep AND r.semester_id=selected AND r.week=nweek AND r.member_id=aid;
     week_data:=week_data || jsonb_build_object('records',records);
    END IF;
    page_data:=page_data || jsonb_build_object('weekData',week_data);
   END IF;
  END IF;
  IF view_name='home' THEN
   result:=result || jsonb_build_object('home',page_data || jsonb_build_object('weekData',week_data,
     'summary',jsonb_build_object('taskCount',coalesce(total,0),'recordCount',coalesce(submitted,0),'coverage',coalesce(coverage,0))));
  ELSE result:=result || jsonb_build_object('page',page_data); END IF;
 END IF;
 RETURN jsonb_build_object('protocolVersion',2,'epoch',ep,'resourceVersions',jsonb_build_object('workspace',w->'version'),'data',result);
END $$;
REVOKE ALL ON FUNCTION xuedu_v2.page_entity(jsonb),xuedu_v2.page_list(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.xuedu_v2_bootstrap_page(text,jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.xuedu_v2_bootstrap_page(text,jsonb,boolean) TO service_role;
COMMIT;
