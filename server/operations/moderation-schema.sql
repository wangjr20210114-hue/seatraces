-- 定义社区举报和内容审核的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS content_reports (
 id uuid PRIMARY KEY, reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
 post_id uuid REFERENCES posts(id) ON DELETE CASCADE, comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
 reason text NOT NULL CHECK(reason IN ('spam','abuse','inaccurate','other')),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved','dismissed')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz, resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
 CHECK((post_id IS NULL)<>(comment_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_open_post ON content_reports(reporter_id,post_id) WHERE state='open' AND post_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reports_open_comment ON content_reports(reporter_id,comment_id) WHERE state='open' AND comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reports_state_created ON content_reports(state,created_at DESC,id);
