-- Short-lived proposal state for the deterministic booking pipeline.
-- A row is written when Remi proposes a specific table (with a config_token)
-- and deleted when the guest confirms, rejects, or the proposal expires.

create table if not exists agent_pending_bookings (
  chat_id text primary key,
  venue_id bigint not null,
  venue_name text not null,
  venue_url text null,
  date text not null,            -- YYYY-MM-DD
  party_size int not null,
  requested_time text not null,  -- HH:MM
  booked_time text not null,     -- HH:MM
  slot_type text not null,
  config_token text not null,
  city text null,
  created_at bigint not null,
  expires_at timestamptz not null
);

create index if not exists agent_pending_bookings_expires_at_idx
  on agent_pending_bookings (expires_at);
