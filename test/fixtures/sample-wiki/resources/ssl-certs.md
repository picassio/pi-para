---
title: SSL Certificates
para: resources
scope:
  - pi-mono
  - global
tags:
  - ssl
  - security
  - infrastructure
sources:
  - https://letsencrypt.org/docs/
created: "2026-04-25"
updated: "2026-04-25"
links:
  - auth-refactor
---

## Topic

SSL certificate management for web services.

## Key Facts

- Use Let's Encrypt for free, automated certificates
- Certificates expire every 90 days — auto-renewal is essential
- Intermediate certificates must be included in the chain

## Insights

- Node.js caches intermediate certs — stale cache causes renewal failures
- Clear cert cache before renewal in CI pipelines

## Connections

- [[auth-refactor]] — JWT-based auth requires HTTPS

## Open Questions

- Should we use cert-manager in Kubernetes or handle certs at the load balancer?

## Sources

- https://letsencrypt.org/docs/
