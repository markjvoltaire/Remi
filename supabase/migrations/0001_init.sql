-- Supabase schema for linq-resy-agent (replaces DynamoDB)
-- Notes:
-- - TTL semantics are emulated in code by checking expires_at on read.
-- - Periodic cleanup can be added later using a scheduled job.

create table if not exists agent_users (
  phone_number text primary key,
  created_at timestamptz not null,
  last_active timestamptz not null,
  onboarding_complete boolean not null default false
);

create table if not exists agent_credentials (
  phone_number text primary key references agent_users(phone_number) on delete cascade,
  encrypted text not null
);

create table if not exists agent_signed_out (
  phone_number text primary key references agent_users(phone_number) on delete cascade
);

create table if not exists agent_just_onboarded (
  phone_number text primary key references agent_users(phone_number) on delete cascade,
  expires_at timestamptz not null
);

create index if not exists agent_just_onboarded_expires_at_idx on agent_just_onboarded (expires_at);

create table if not exists agent_pending_otp (
  phone_number text primary key references agent_users(phone_number) on delete cascade,
  chat_id text not null,
  sent_at timestamptz not null,
  expires_at timestamptz not null
);

create index if not exists agent_pending_otp_expires_at_idx on agent_pending_otp (expires_at);

create table if not exists agent_pending_challenges (
  phone_number text primary key references agent_users(phone_number) on delete cascade,
  chat_id text not null,
  claim_token text not null,
  challenge_id text not null,
  mobile_number text not null,
  first_name text null,
  is_new_user boolean not null default false,
  required_fields jsonb not null,
  sent_at timestamptz not null,
  expires_at timestamptz not null
);

create index if not exists agent_pending_challenges_expires_at_idx on agent_pending_challenges (expires_at);

create table if not exists agent_auth_tokens (
  token text primary key,
  phone_number text not null references agent_users(phone_number) on delete cascade,
  chat_id text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used boolean not null default false
);

create index if not exists agent_auth_tokens_expires_at_idx on agent_auth_tokens (expires_at);

create table if not exists agent_conversations (
  chat_id text primary key,
  messages jsonb not null,
  last_active bigint not null,
  expires_at timestamptz not null
);

create index if not exists agent_conversations_expires_at_idx on agent_conversations (expires_at);

create table if not exists agent_user_profiles (
  handle text primary key,
  name text null,
  facts jsonb not null,
  first_seen bigint not null,
  last_seen bigint not null
);

create table if not exists agent_chat_counts (
  chat_id text primary key,
  count bigint not null,
  expires_at timestamptz not null
);

create index if not exists agent_chat_counts_expires_at_idx on agent_chat_counts (expires_at);

