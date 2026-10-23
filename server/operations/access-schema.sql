-- 定义后台成员、角色和会话的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS admin_memberships (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('operator','support','analyst')),
 enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS admin_access_version integer;
