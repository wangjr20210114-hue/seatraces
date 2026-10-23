-- 定义站内信、发送对象和阅读状态的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS inbox_campaigns (
 id uuid PRIMARY KEY, created_by uuid NOT NULL REFERENCES users(id),
 title varchar(80) NOT NULL, body varchar(4000) NOT NULL,
 audience text NOT NULL CHECK(audience IN ('all','selected')),
 recipient_ids uuid[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','cancelled')),
 version integer NOT NULL DEFAULT 1, recipient_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS inbox_campaigns_created ON inbox_campaigns(created_at DESC,id);
CREATE TABLE IF NOT EXISTS inbox_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES inbox_campaigns(id),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(campaign_id,user_id)
);
CREATE INDEX IF NOT EXISTS inbox_messages_owner ON inbox_messages(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS inbox_messages_unread ON inbox_messages(user_id) WHERE read_at IS NULL;
