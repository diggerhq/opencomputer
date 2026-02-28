-- Org secrets vault: encrypted API keys and other sensitive values.
-- Real values are AES-256-GCM encrypted at rest.
CREATE TABLE IF NOT EXISTS org_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  encrypted_value TEXT NOT NULL,    -- AES-256-GCM, base64, prefix 'enc:'
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, name)
);

-- Secret groups bundle multiple secrets with optional egress host restrictions.
CREATE TABLE IF NOT EXISTS secret_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  allowed_hosts TEXT[],             -- wildcard egress allowlist, NULL = all allowed
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, name)
);

-- Maps secrets to groups with the env var name to expose inside the sandbox.
CREATE TABLE IF NOT EXISTS secret_group_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES secret_groups(id) ON DELETE CASCADE,
  secret_id UUID NOT NULL REFERENCES org_secrets(id) ON DELETE CASCADE,
  env_var_name TEXT NOT NULL,
  UNIQUE(group_id, env_var_name)
);

-- Link sandbox sessions to the secret group that was attached at creation.
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS secret_group_id UUID REFERENCES secret_groups(id);
