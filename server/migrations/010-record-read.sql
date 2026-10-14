-- Apply after 009. Internal request-scoped read set; no table grants or business writes.
BEGIN;
CREATE FUNCTION public.xuedu_v2_record_read(p_identity_key text, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 w jsonb; ep text; binding jsonb; actor jsonb; receipt jsonb; rows jsonb;
 kind text:=p_request->>'kind'; sid text:=p_request->>'semesterId';
 task jsonb; rec jsonb; sem jsonb; occurrence jsonb; images jsonb;
BEGIN
 PERFORM xuedu_v2.require_server();
 IF coalesce(p_identity_key,'')='' OR length(p_identity_key)>200
   OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR octet_length(p_request::text)>10000
   OR kind IS NULL OR kind NOT IN ('photo','recordSubmit','recordEdit') THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 PERFORM 1 FROM xuedu_v2.workspace WHERE id='main' FOR SHARE NOWAIT;
 w:=public.xuedu_v2_workspace(); ep:=w->>'epoch';
 IF p_request->>'epoch' IS DISTINCT FROM ep THEN RAISE EXCEPTION 'EPOCH_CHANGED'; END IF;
 SELECT xuedu_v2.entity(to_jsonb(b)),xuedu_v2.entity(to_jsonb(m)) INTO binding,actor
 FROM xuedu_v2.bindings b JOIN xuedu_v2.members m ON m.id=b.member_id AND m.epoch=ep
 WHERE b.epoch=ep AND b.identity_key=p_identity_key;
 IF actor IS NULL OR actor->'data'->'active' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 rows:=jsonb_build_object('bindings',jsonb_build_array(binding),'members',jsonb_build_array(actor));
 SELECT xuedu_v2.entity(to_jsonb(r)) INTO receipt FROM xuedu_v2.requests r
 WHERE r.epoch=ep AND r.identity_key=p_identity_key AND r.parent_id=p_request->>'requestId';
 rows:=rows || jsonb_build_object('requests',CASE WHEN receipt IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(receipt) END);
 IF receipt IS NOT NULL THEN
  IF receipt->'data'->'permissionsVersion' IS DISTINCT FROM w->'permissionsVersion' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  RETURN jsonb_build_object('workspace',w,'rows',rows);
 END IF;
 IF w->>'maintenance'<>'' THEN RAISE EXCEPTION 'MAINTENANCE'; END IF;
 IF coalesce(sid,'')='' OR length(sid)>200 THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
 IF kind='recordEdit' THEN
  SELECT xuedu_v2.entity(to_jsonb(r)) INTO rec FROM xuedu_v2.records r WHERE r.epoch=ep AND r.id=p_request->>'id';
 ELSE
  SELECT xuedu_v2.entity(to_jsonb(t)) INTO task FROM xuedu_v2.tasks t WHERE t.epoch=ep AND t.id=p_request->>'taskId';
  SELECT xuedu_v2.entity(to_jsonb(r)) INTO rec FROM xuedu_v2.records r WHERE r.epoch=ep AND r.task_id=task->>'id';
 END IF;
 -- These rows never leave the gateway. Business ownership, edit window, status,
 -- expected versions and photo binding remain checked there and at commit.
 SELECT xuedu_v2.entity(to_jsonb(s)) INTO sem FROM xuedu_v2.semesters s WHERE s.epoch=ep AND s.id=sid;
 SELECT xuedu_v2.entity(to_jsonb(o)) INTO occurrence FROM xuedu_v2.occurrences o
 WHERE o.epoch=ep AND o.id=task->'data'->>'occurrenceId';
 images:='[]'::jsonb;
 IF kind<>'photo' THEN
  IF jsonb_typeof(p_request->'photos') IS DISTINCT FROM 'array' OR jsonb_array_length(p_request->'photos')>3 THEN RAISE EXCEPTION 'INVALID_QUERY'; END IF;
  SELECT coalesce(jsonb_agg(xuedu_v2.entity(to_jsonb(p))),'[]'::jsonb) INTO images
  FROM xuedu_v2.photos p WHERE p.epoch=ep AND p.id IN (SELECT jsonb_array_elements_text(p_request->'photos'));
 END IF;
 rows:=rows || jsonb_build_object('tasks',CASE WHEN task IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(task) END,
 'records',CASE WHEN rec IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(rec) END,
 'semesters',CASE WHEN sem IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(sem) END,
 'occurrences',CASE WHEN occurrence IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(occurrence) END,'photos',images);
 RETURN jsonb_build_object('workspace',w,'rows',rows);
END $$;
REVOKE ALL ON FUNCTION public.xuedu_v2_record_read(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.xuedu_v2_record_read(text,jsonb) TO service_role;
COMMIT;
