# Changelog

## 2026-08-13

### Onboarding
- Docker is now checked immediately when `scripts/onboard.ts` starts, before any prompts or AWS calls — a missing/stopped Docker daemon now fails fast instead of only surfacing after you've answered every prompt and waited through the full AWS deploy.
- Added a fallback for the original check (still run right before the image build): if Docker gets stopped mid-run, onboarding now pauses and asks you to start it back up and press Enter to retry, instead of erroring out after AWS resources have already been provisioned.

### Postman sync
- Added `.postman/workflows.yaml`, declaring the spec ↔ collection sync relationship for the `PostFinanceCo API` spec/collection pair (bidirectional, with examples synced and folders grouped by tag).
- Removed duplicate collections and specs (`PostFinanceCo API V1.5`, `PostFinanceCo API V2` and their spec files) — there's now a single canonical `PostFinanceCo API` collection/spec instead of multiple out-of-date copies.
- Added `restore_points/` (zip snapshots of collection versions 1, 1.5, and 2) and a new `scripts/restore-collection.sh -v <1|1.5|2>` helper, so any of those older collection versions can still be restored on demand even though they're no longer checked in directly.

### Monitoring
- Simplified `scripts/create-monitors.ts` and the README's monitoring section to set up a single "AWS Prod Health Check" monitor, dropping the separate "AWS Dev Health Check" — monitoring is now prod-only.

### Docs
- Fixed a stale collection path in the README (`postman/collections/SE Demo API/` → `postman/collections/PostFinanceCo API/`).
