# Linq Resy Agent

A Resy reservation agent accessible via iMessage. Text the bot to search restaurants, check availability, and book tables — all through natural conversation.

Built on [Linq Blue](https://linqapp.com) and powered by Claude (Anthropic).

## What it does

- **Search restaurants** — find places on Resy by name, cuisine, or location
- **Check availability** — see open time slots for any date and party size
- **Book tables** — make real Resy reservations via text
- **Manage reservations** — view upcoming bookings and cancel when needed
- **Natural conversation** — Claude handles the back-and-forth, remembers context

## Architecture

```
User ──iMessage──▶ Linq Blue ──webhook──▶ linq-resy-agent ──▶ Claude (tool-use loop)
                                               │                    │
                                               │     ◀── tools ◀────┘
                                               │     resy_search
                                               │     resy_find_slots
                                               │     resy_book
                                               │     resy_cancel
                                               │     resy_reservations
                                               ▼
User ◀─iMessage── Linq Blue ◀───API──── Response
```

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- [ngrok](https://ngrok.com) (for local development)
- [Linq Blue](https://linqapp.com) account (free sandbox)
- [Anthropic](https://console.anthropic.com) API key
- A [Resy](https://resy.com) account

### Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and fill in your keys. For `RESY_AUTH_TOKEN`:

1. Go to [resy.com](https://resy.com) and sign in
2. Open DevTools (F12) → Network tab
3. Click around to trigger any API request to `api.resy.com`
4. Copy the `x-resy-auth-token` header value

### Storage (Supabase)

The agent stores users, credentials, onboarding state, and conversation history in Supabase (recommended).

1. Create a Supabase project.
2. Run the SQL migration in your Supabase SQL editor: `supabase/migrations/0001_init.sql`.
3. Set these environment variables in `.env`:
   - `STORAGE_PROVIDER=supabase`
   - `SUPABASE_URL=...`
   - `SUPABASE_SERVICE_ROLE_KEY=...` (server-side only; do not expose to clients)

### Run

```bash
npm run dev

# In another terminal
ngrok http 3000
```

Set your ngrok URL as the webhook in your [Linq Blue dashboard](https://linqapp.com).

## Project Structure

```
src/
├── index.ts              # Express server, webhook handler, orchestration
├── auth/                 # Magic link onboarding, credential encryption
│   ├── routes.ts         # /auth/setup page and credential submission
│   ├── encryption.ts     # AES-256-GCM credential encryption
│   ├── magicLink.ts      # Token generation and verification
│   ├── db.ts             # In-memory user/credential store
│   └── userContext.ts    # Load credentials per request (env fallback)
├── claude/
│   └── client.ts         # Claude API, system prompt, Resy tool definitions
├── bookings/
│   ├── client.ts         # Resy API client (search, slots, book, cancel)
│   ├── types.ts          # Resy type definitions
│   └── index.ts          # Barrel export
├── linq/
│   └── client.ts         # Linq Blue API (send messages, reactions, effects)
├── state/
│   └── conversation.ts   # Conversation history and user profiles (in-memory)
├── utils/
│   └── redact.ts         # Phone number redaction for logs
└── webhook/
    ├── handler.ts        # Webhook processing and phone filtering
    └── types.ts          # Webhook event types
```

## Auth Modes

**Dev mode** — Set `RESY_AUTH_TOKEN` in `.env` and all users share your Resy account. No onboarding needed.

**SMS OTP (default)** — Users verify via Resy's native SMS OTP flow. Text the bot → receive a code → verify with your account email → connected. No manual token copying needed.

**Inline JWT** — Power users can paste their `x-resy-auth-token` directly (starts with `eyJ...`). Useful when SMS is rate-limited.

All credentials are encrypted (AES-256-GCM) and stored per-user.

## Resy Tools

| Tool                | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `resy_search`       | Search restaurants by keyword and location            |
| `resy_find_slots`   | Find available time slots for a venue/date/party size |
| `resy_book`         | Book a reservation using a config token               |
| `resy_cancel`       | Cancel a reservation using a resy token               |
| `resy_reservations` | List upcoming reservations                            |
| `resy_profile`      | Get user's Resy profile (name, email, member info)    |
| `resy_sign_out`     | Disconnect Resy account and clear credentials         |

## Deployment

### Single-node server (Supabase)

This project runs in “single node” mode when you do **not** set `AWS_LAMBDA_FUNCTION_NAME` (it starts the Express listener directly).

1. Run migrations in your Supabase project (see `supabase/migrations/0001_init.sql`).
2. Set environment variables:
   - `STORAGE_PROVIDER=supabase`
   - `SUPABASE_URL=...`
   - `SUPABASE_SERVICE_ROLE_KEY=...`
3. Start the server:

```bash
npm run build
NODE_ENV=production npm start
```

### Docker

```bash
docker build -t linq-resy-agent .
docker run -p 3000:3000 --env-file .env linq-resy-agent
```

Also supports Railway, Fly.io, and Heroku (`Procfile` included).

## Built with

- [Linq Blue](https://linqapp.com) — iMessage/RCS messaging API
- [Claude](https://anthropic.com) (Anthropic) — AI reasoning with tool use
- [Resy](https://resy.com) — Restaurant reservation platform

## License

MIT

hello
