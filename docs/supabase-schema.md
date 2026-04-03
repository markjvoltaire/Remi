# Supabase schema (Remi)

This project can persist agent state in **Supabase** instead of DynamoDB. The SQL lives under `supabase/migrations/`; the app talks to Postgres through `@supabase/supabase-js` in [`src/db/supabase.ts`](../src/db/supabase.ts).

## Configuration

| Variable | Purpose |
|----------|---------|
| `STORAGE_PROVIDER` | Set to `supabase` (default) or `dynamodb`. |
| `SUPABASE_URL` | Project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side only; used with `persistSession: false`. |

Apply migrations in order in the Supabase SQL editor (or CLI):

1. `supabase/migrations/0001_init.sql`
2. `supabase/migrations/0002_profile_onboarding.sql`

## Design notes

- **Logical keys:** The storage API still uses a Dynamo-style **partition key (PK)** and **sort key (SK)**. [`entityFromPk`](../src/db/supabase.ts) maps those strings to tables and primary keys.
- **TTL:** Tables may include `expires_at`. Supabase does not auto-delete these rows; **expiry is enforced in application code** on read (`getItem` returns `null` when past `expires_at`). Optional future cleanup: scheduled job or Postgres `pg_cron`.
- **Security:** The service role key bypasses RLS. Do not expose it to browsers or mobile clients.

## PK / SK → table mapping

| PK prefix | Example PK | SK (sort key) | Table |
|-----------|------------|---------------|--------|
| `USER#` | `USER#+15551234567` | `PROFILE` | `agent_users` |
| | | `CREDENTIALS` | `agent_credentials` |
| | | `SIGNED_OUT` | `agent_signed_out` |
| | | `JUST_ONBOARDED` | `agent_just_onboarded` |
| | | `PROFILE_ONBOARDING` | `agent_profile_onboarding` |
| | | `PENDING_OTP` | `agent_pending_otp` |
| | | `PENDING_CHALLENGE` | `agent_pending_challenges` |
| `AUTHTOKEN#` | `AUTHTOKEN#<token>` | `AUTHTOKEN` | `agent_auth_tokens` |
| `CONV#` | `CONV#<chat_id>` | `CONV` | `agent_conversations` |
| `USERPROFILE#` | `USERPROFILE#<handle>` | `USERPROFILE` | `agent_user_profiles` |
| `CHATCOUNT#` | `CHATCOUNT#<chat_id>` | `CHATCOUNT` | `agent_chat_counts` |

---

## Tables

### `agent_users`

Core row per SMS/user **phone number** (E.164).

| Column | Type | Notes |
|--------|------|--------|
| `phone_number` | `text` | Primary key. |
| `created_at` | `timestamptz` | |
| `last_active` | `timestamptz` | |
| `onboarding_complete` | `boolean` | Default `false`. |

Referenced by all user-scoped tables below (`on delete cascade`).

---

### `agent_credentials`

Encrypted Resy (or other) credentials for that user.

| Column | Type | Notes |
|--------|------|--------|
| `phone_number` | `text` | PK, FK → `agent_users`. |
| `encrypted` | `text` | Ciphertext; decryption key is app env (`CREDENTIAL_ENCRYPTION_KEY`). |

---

### `agent_signed_out`

Marker row: user has signed out (session cleared). Presence of a row means signed out; payload is empty in the storage API.

| Column | Type | Notes |
|--------|------|--------|
| `phone_number` | `text` | PK, FK → `agent_users`. |

---

### `agent_just_onboarded`

Short-lived flag after onboarding completes (UX / messaging).

| Column | Type | Notes |
|--------|------|--------|
| `phone_number` | `text` | PK, FK → `agent_users`. |
| `expires_at` | `timestamptz` | TTL; ignored by app when expired. |

Index: `agent_just_onboarded_expires_at_idx` on `expires_at`.

---

### `agent_pending_otp`

OTP / magic-link style pending state tied to a chat.

| Column | Type | Notes |
|--------|------|--------|
| `phone_number` | `text` | PK, FK → `agent_users`. |
| `chat_id` | `text` | Linq (or provider) chat id. |
| `sent_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | TTL on read. |

Index: `agent_pending_otp_expires_at_idx` on `expires_at`.

---

### `agent_pending_challenges`

Structured onboarding challenge (e.g. claim flow) with required fields.

| Column | Type | Notes |
|--------|------|--------|
| `phone_number` | `text` | PK, FK → `agent_users`. |
| `chat_id` | `text` | |
| `claim_token` | `text` | |
| `challenge_id` | `text` | |
| `mobile_number` | `text` | |
| `first_name` | `text` | Nullable. |
| `is_new_user` | `boolean` | Default `false`. |
| `required_fields` | `jsonb` | |
| `sent_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | TTL on read. |

Index: `agent_pending_challenges_expires_at_idx` on `expires_at`.

---

### `agent_auth_tokens`

One-time or time-bound tokens linking `phone_number` and `chat_id` (e.g. magic links).

| Column | Type | Notes |
|--------|------|--------|
| `token` | `text` | Primary key. |
| `phone_number` | `text` | FK → `agent_users`. |
| `chat_id` | `text` | |
| `created_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | TTL on read. |
| `used` | `boolean` | Default `false`. Updatable via `updateItem` on this entity. |

Index: `agent_auth_tokens_expires_at_idx` on `expires_at`.

---

### `agent_conversations`

Conversation transcript / message list for a **chat id** (not keyed by phone in this table).

| Column | Type | Notes |
|--------|------|--------|
| `chat_id` | `text` | Primary key. |
| `messages` | `jsonb` | Serialized messages. |
| `last_active` | `bigint` | Epoch ms (stored as bigint). |
| `expires_at` | `timestamptz` | TTL on read. |

Index: `agent_conversations_expires_at_idx` on `expires_at`.

---

### `agent_user_profiles`

Lightweight profiles keyed by **handle** (e.g. social or internal handle), separate from phone-keyed users.

| Column | Type | Notes |
|--------|------|--------|
| `handle` | `text` | Primary key. |
| `name` | `text` | Nullable. |
| `facts` | `jsonb` | Structured facts. |
| `first_seen` | `bigint` | Epoch ms. |
| `last_seen` | `bigint` | Epoch ms. |

---

### `agent_chat_counts`

Per-chat counter with TTL (rate limits, analytics, etc.).

| Column | Type | Notes |
|--------|------|--------|
| `chat_id` | `text` | Primary key. |
| `count` | `bigint` | |
| `expires_at` | `timestamptz` | TTL on read. |

Index: `agent_chat_counts_expires_at_idx` on `expires_at`.

---

### `agent_profile_onboarding`

Conversational profile onboarding (name, city, neighborhood, dietary). Added in `0002_profile_onboarding.sql`.

| Column | Type | Notes |
|--------|------|--------|
| `phone_number` | `text` | PK, FK → `agent_users`. |
| `stage` | `text` | Default `'ask_name'`. |
| `name` | `text` | Nullable. |
| `city` | `text` | Nullable. |
| `neighborhood` | `text` | Nullable. |
| `dietary` | `text` | Nullable. |
| `completed` | `boolean` | Default `false`. |
| `updated_at` | `timestamptz` | Default `now()`. |

---

## Deletes

Deleting `PROFILE` (`agent_users` row) cascades to dependent user tables. Other entities delete single-table rows by primary key (see `deleteItem` in `supabase.ts`).
