-- Store conversational profile onboarding state (name/city/neighborhood/dietary).

create table if not exists agent_profile_onboarding (
  phone_number text primary key references agent_users(phone_number) on delete cascade,
  stage text not null default 'ask_name',
  name text,
  city text,
  neighborhood text,
  dietary text,
  completed boolean not null default false,
  updated_at timestamptz not null default now()
);

