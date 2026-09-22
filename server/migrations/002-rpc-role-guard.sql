-- Upgrade for environments where 001 ran before explicit JWT role checks.
-- No data deletion or new grants. Platform-injected claims, not function args.
BEGIN;
CREATE OR REPLACE FUNCTION public.xuedu_read_workspace(p_stage text, p_initial jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  IF COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'server role required' USING ERRCODE = '42501';
  END IF;
  IF p_stage NOT IN ('trial', 'production') OR
     p_initial->>'stage' IS DISTINCT FROM p_stage OR
     p_initial->'state'->>'actorId' IS DISTINCT FROM '' OR
     octet_length(p_initial::text) > 900000 THEN
    RAISE EXCEPTION 'invalid initial workspace';
  END IF;
  INSERT INTO xuedu_private.workspace(stage, document)
  VALUES (p_stage, p_initial) ON CONFLICT(stage) DO NOTHING;
  SELECT jsonb_build_object('revision', revision, 'document', document)
  INTO result FROM xuedu_private.workspace WHERE stage = p_stage;
  RETURN result;
END;
$$;
CREATE OR REPLACE FUNCTION public.xuedu_commit_workspace(p_stage text, p_revision bigint, p_document jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'server role required' USING ERRCODE = '42501';
  END IF;
  IF p_stage NOT IN ('trial', 'production') OR
     p_document->>'stage' IS DISTINCT FROM p_stage OR
     p_document->'state'->>'actorId' IS DISTINCT FROM '' OR
     octet_length(p_document::text) > 900000 THEN
    RAISE EXCEPTION 'invalid workspace';
  END IF;
  UPDATE xuedu_private.workspace
  SET document = p_document, revision = revision + 1, updated_at = now()
  WHERE stage = p_stage AND revision = p_revision;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.xuedu_read_workspace(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xuedu_commit_workspace(text, bigint, jsonb) FROM PUBLIC, anon, authenticated;
COMMIT;
