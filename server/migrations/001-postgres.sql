-- Run once in the dedicated xuedu CloudBase PG environment SQL editor.
-- Trial-sized JSONB aggregate; this does not replace future multi-table work.
BEGIN;
CREATE SCHEMA IF NOT EXISTS xuedu_private;
REVOKE ALL ON SCHEMA xuedu_private FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS xuedu_private.workspace (
  stage text PRIMARY KEY CHECK (stage IN ('trial', 'production')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (document->>'stage' = stage),
  CHECK (document->'state'->>'actorId' = '')
);
ALTER TABLE xuedu_private.workspace ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON xuedu_private.workspace FROM PUBLIC, anon, authenticated;

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
GRANT EXECUTE ON FUNCTION public.xuedu_read_workspace(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.xuedu_commit_workspace(text, bigint, jsonb) TO service_role;

-- Storage stays private with no client policies; only server-side access.
INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('xuedu-photos', 'xuedu-photos', false, 525000, ARRAY['image/jpeg', 'image/png'])
ON CONFLICT(id) DO NOTHING;
COMMIT;
