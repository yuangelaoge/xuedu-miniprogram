-- Optional review-only sandbox. Apply separately after independent verification; never migrates production rows.
-- All calls require the existing service_role-only xuedu_v2.require_server guard.
BEGIN;
CREATE SCHEMA IF NOT EXISTS xuedu_review;
REVOKE ALL ON SCHEMA xuedu_review FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS xuedu_review.sessions (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  snapshot jsonb CHECK (snapshot IS NULL OR octet_length(snapshot::text) <= 524288),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','leader','member','applicant')),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS review_sessions_expiry ON xuedu_review.sessions(expires_at);
CREATE TABLE IF NOT EXISTS xuedu_review.attempts (
  digest text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT clock_timestamp(),
  failures integer NOT NULL DEFAULT 0,
  locked_until timestamptz NOT NULL DEFAULT '-infinity'::timestamptz
);
INSERT INTO xuedu_review.attempts(digest) VALUES('global') ON CONFLICT DO NOTHING;
ALTER TABLE xuedu_review.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE xuedu_review.attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON xuedu_review.sessions, xuedu_review.attempts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.xuedu_review_login(p_digest text,p_valid boolean,p_snapshot jsonb,p_expires_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g xuedu_review.attempts; a xuedu_review.attempts; t timestamptz := clock_timestamp(); BEGIN
  PERFORM xuedu_v2.require_server();
  IF p_digest IS NULL OR p_snapshot IS NULL OR p_expires_at IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_snapshot->'workspace'->>'id' <> 'review' OR p_snapshot->'workspace'->>'epoch' NOT LIKE 'review-%' OR octet_length(p_snapshot::text)>524288 OR p_expires_at<=t OR p_expires_at>t+interval '61 minutes' THEN RAISE EXCEPTION 'INVALID_REVIEW_REQUEST'; END IF;
  INSERT INTO xuedu_review.attempts(digest) VALUES(p_digest) ON CONFLICT DO NOTHING;
  SELECT * INTO g FROM xuedu_review.attempts WHERE digest='global' FOR UPDATE;
  SELECT * INTO a FROM xuedu_review.attempts WHERE digest=p_digest FOR UPDATE;
  IF g.window_start<t-interval '15 minutes' THEN UPDATE xuedu_review.attempts SET window_start=t,failures=0,locked_until='-infinity'::timestamptz WHERE digest='global'; g.failures:=0; g.locked_until:='-infinity'; END IF;
  IF a.window_start<t-interval '15 minutes' THEN UPDATE xuedu_review.attempts SET window_start=t,failures=0,locked_until='-infinity'::timestamptz WHERE digest=p_digest; a.failures:=0; a.locked_until:='-infinity'; END IF;
  IF g.locked_until>t OR a.locked_until>t THEN RETURN false; END IF;
  IF NOT p_valid THEN
    UPDATE xuedu_review.attempts SET failures=failures+1,locked_until=CASE WHEN failures+1>=30 THEN t+interval '15 minutes' ELSE locked_until END WHERE digest='global';
    UPDATE xuedu_review.attempts SET failures=failures+1,locked_until=CASE WHEN failures+1>=5 THEN t+interval '15 minutes' ELSE locked_until END WHERE digest=p_digest;
    RETURN false;
  END IF;
  UPDATE xuedu_review.attempts SET failures=0 WHERE digest=p_digest;
  DELETE FROM xuedu_review.sessions WHERE expires_at<t;
  DELETE FROM xuedu_review.attempts WHERE digest NOT IN ('global',p_digest) AND window_start<t-interval '1 day';
  INSERT INTO xuedu_review.sessions(digest,snapshot,version,role,expires_at,updated_at) VALUES(p_digest,p_snapshot,1,'admin',p_expires_at,t)
    ON CONFLICT(digest) DO UPDATE SET snapshot=excluded.snapshot,version=xuedu_review.sessions.version+1,role='admin',expires_at=excluded.expires_at,updated_at=t;
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.xuedu_review_read(p_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s xuedu_review.sessions; BEGIN
  PERFORM xuedu_v2.require_server();
  IF p_digest !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  SELECT * INTO s FROM xuedu_review.sessions WHERE digest=p_digest AND expires_at>clock_timestamp() AND snapshot IS NOT NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('snapshot',s.snapshot,'version',s.version,'role',s.role,'expiresAt',s.expires_at);
END $$;
CREATE OR REPLACE FUNCTION public.xuedu_review_save(p_digest text,p_expected_version bigint,p_snapshot jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v bigint; BEGIN
  PERFORM xuedu_v2.require_server();
  IF p_digest IS NULL OR p_snapshot IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_snapshot->'workspace'->>'id'<>'review' OR p_snapshot->'workspace'->>'epoch' NOT LIKE 'review-%' OR octet_length(p_snapshot::text)>524288 THEN RAISE EXCEPTION 'INVALID_REVIEW_REQUEST'; END IF;
  UPDATE xuedu_review.sessions SET snapshot=p_snapshot,version=version+1,updated_at=clock_timestamp()
   WHERE digest=p_digest AND version=p_expected_version AND expires_at>clock_timestamp() AND snapshot IS NOT NULL RETURNING version INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'REVIEW_VERSION_CONFLICT'; END IF;
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION public.xuedu_review_role(p_digest text,p_expected_version bigint,p_role text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v bigint; BEGIN
  PERFORM xuedu_v2.require_server();
  IF p_role NOT IN ('admin','leader','member','applicant') OR p_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_REVIEW_REQUEST'; END IF;
  UPDATE xuedu_review.sessions SET role=p_role,version=version+1,updated_at=clock_timestamp()
   WHERE digest=p_digest AND version=p_expected_version AND expires_at>clock_timestamp() AND snapshot IS NOT NULL RETURNING version INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'REVIEW_VERSION_CONFLICT'; END IF;
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION public.xuedu_review_logout(p_digest text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  PERFORM xuedu_v2.require_server();
  UPDATE xuedu_review.sessions SET snapshot=NULL,expires_at=clock_timestamp(),version=version+1 WHERE digest=p_digest;
END $$;
REVOKE ALL ON FUNCTION public.xuedu_review_login(text,boolean,jsonb,timestamptz), public.xuedu_review_read(text), public.xuedu_review_save(text,bigint,jsonb), public.xuedu_review_role(text,bigint,text), public.xuedu_review_logout(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xuedu_review_login(text,boolean,jsonb,timestamptz), public.xuedu_review_read(text), public.xuedu_review_save(text,bigint,jsonb), public.xuedu_review_role(text,bigint,text), public.xuedu_review_logout(text) TO service_role;
COMMIT;
