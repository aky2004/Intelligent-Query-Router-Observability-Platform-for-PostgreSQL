# Blueprint redesign, landing pages, and secure authentication

## What will change
- Replace the current dashboard-first home page with a public pg-router-ai landing page in the requested Paper/Forest technical-minimalist style.
- Add a fixed indexed navigation, oversized product statement, animated network topology, status badge, 2×2 bento feature grid, testimonial, and technical signup CTA.
- Restyle the existing dashboard shell and all product pages to share the same flat blueprint system: mosaic grid, 1px dividers, square corners, Space Grotesk/General Sans/JetBrains Mono, and Coral/Mint/Gold accents.
- Keep the current observability tools available behind a signed-in app area, with clear sign-in and account actions.

## Authentication and profiles
- Add account creation, email/password sign-in, OTP verification, refresh-token rotation, access-token validation, sign-out, password recovery, and protected app access.
- Add a `profiles` record linked to each account for display name, avatar, role, and preferences.
- Store refresh tokens as hashed, revocable records; use short-lived signed access tokens and rotate refresh tokens on every refresh.
- Replace the current WebSocket payload-only check with real signature, expiry, and account validation.

## Email and background jobs
- Add Redis-backed BullMQ queues for OTP expiry, delivery, retries, and email jobs.
- Deliver OTP and account emails through the linked Brevo connector; credentials remain server-side and are never committed to source.
- Add retry limits, idempotent job IDs, OTP hashing, attempt limits, and generic responses that do not reveal whether an address exists.

## Technical details
- Extend the standalone Node/Express backend because BullMQ, Redis, persistent Socket.io, and custom JWT rotation require that server runtime.
- Add PostgreSQL migrations for profiles, refresh sessions, and OTP challenges, including indexes and role-safe access patterns.
- Add REST authentication endpoints and middleware while preserving the existing `ApiResponse<T>` envelope and rate limits.
- Add focused tests for token rotation/reuse rejection, OTP expiry and attempt limits, protected endpoints, and WebSocket authentication.
- Use the Brevo API connector rather than the SMTP password included in chat; the exposed password should be rotated in Brevo.

## Verification
- Verify the landing page and dashboard at desktop and mobile widths.
- Run backend tests and type checks, then exercise signup → OTP → sign-in → refresh → protected request → sign-out end to end in simulated/local mode.
