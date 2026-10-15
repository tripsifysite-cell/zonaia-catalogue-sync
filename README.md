# Controlled catalogue refresh

Small standalone scheduled publisher. This repository contains **code and publication hashes only**, not application source, catalogue records, authentication state or credentials.

The website remains available from its last successful deployment when refresh fails.

## Safety boundaries

- Only reviewed code on protected `main` receives environment secrets.
- No pull-request secret access, third-party dependencies, private-repository token, service-role database key or Cloudflare account token.
- Dedicated publisher may read snapshots and create immutable versions only. It cannot modify business records or overwrite/delete snapshots.
- Weekly publication; at least six days between successful versions and no more than five within 31 days. Initial full baseline requires explicit manual bootstrap once; no automatic full-export fallback.
- Metadata inventory detects changes/deletions. Subsequent refreshes read only changed records, with bounded bytes, rows and requests.
- Stop before snapshot storage exceeds 500 MB. Old versions are not deleted automatically. Maintenance approval is needed when the cap is reached.
- No catalogue artifacts/caches uploaded to GitHub. Logs contain stage/error codes, never raw rows or provider responses.
- Public `state` branch contains manifest path, SHA-256 and bounded budget bookkeeping, **not** records, credentials or URLs carrying secrets.

Scheduling is best-effort, not continuous monitoring or an uptime guarantee. GitHub may suspend schedules in inactive public repositories. Free provider quotas still apply, including Supabase egress for website builds.
