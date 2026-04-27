---
title: Auth Refactor
para: projects
scope:
  - pi-mono
tags:
  - authentication
  - jwt
sources:
  - "session:~/.pi/agent/sessions/--home-ubuntu-projects-pi-mono--/2026-04-24_abc123.jsonl"
created: "2026-04-24"
updated: "2026-04-24"
links:
  - ssl-certs
---

## Topic

Refactoring the authentication system from session cookies to JWT tokens.

## Key Facts

- Moving from express-session to jsonwebtoken
- Access tokens expire in 15 minutes, refresh tokens in 7 days
- Tokens stored in httpOnly cookies for web, Authorization header for mobile

## Insights

- Stateless JWT simplifies horizontal scaling — no shared session store needed
- Refresh token rotation prevents token theft from being permanent

## Connections

- [[ssl-certs]] — JWT requires HTTPS in production

## Open Questions

- Should we support both session and JWT during migration?

## Sources

- session:~/.pi/agent/sessions/--home-ubuntu-projects-pi-mono--/2026-04-24_abc123.jsonl
