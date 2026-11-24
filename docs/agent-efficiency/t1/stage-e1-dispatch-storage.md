# T1-E1 dispatch storage foundation

The owner authorized starting E1 while revision 2 was in review. Migration 0028 adds immutable reservation identities, chargeable attempts and dispatch events. Existing scheduler and Cost Guard behavior continues through the current paths. [E1 start recorded on issue #23](https://github.com/shmtoan08/SoftwareFactory/issues/23#issuecomment-7101977971)

Reservations can exist independently of a prepared attempt. Project-scoped uniqueness reserves one ordinal per logical invocation and one reservation per attempt. Composite foreign keys enforce project and task consistency across the reserved cost session, lifecycle, lease and optional pipeline session. Attempt epoch, execution and generation references are stored for the authority functions to verify against live state.

Event rows accept PREPARED, then either DISPATCH_STARTED or CONFIRMED_NOT_SENT. A TERMINAL row requires the exact start event as its predecessor. Sequence uniqueness prevents a later no-send event from replacing a recorded start. Every table uses FORCE RLS with no policies, and existing service roles have no grants. The SQL tests use administrative fixtures within a rollback to exercise the constraints and verify write, read and mutation denial.

Migration 0029 adds a same-project ledger foreign key on TERMINAL and a unique index that prevents a finalized ledger from being attached to two attempts. The new index on the business ledger supports that foreign key. Settlement identity checks and HMAC evidence still belong to a later typed writer.

The expiry recovery function requires a project-bound recovery login and a READ COMMITTED transaction. It uses a nonblocking reservation lock. An expired orphan receives an immutable release record. An expired prepared attempt also receives CONFIRMED_NOT_SENT in the same transaction. A recorded start takes precedence over expiry. The migration installs a role group and function ACL, with login and project binding left to provisioning.

Migration 0030 adds project-bound prepare/start functions for the managed worker candidate. Both take the recovery reservation lock with seed 2929, then lock the task and active lease rows with NOWAIT. The managed candidate uses the lease UUID as the execution reference and the active lease epoch as the generation. Reservations without that recorded lease binding are ineligible. Prepare derives the binding digest and verifies task, lifecycle and cost session scope. Start checks release and expiry before appending one start event. A duplicate returns only a receipt. Transport in E2 must require acknowledged commit plus a single-use permit.

For row locking, the function owner receives UPDATE privilege on one identifier column per fenced table. A restrictive RLS policy rejects actual updates by that role. Project-bound service logins receive only function execution. The TypeScript runtime currently has no caller for these functions and the migration provisions no login or fixture reservation in production.

The two-session test covers contention with the task lock, recovery's reservation lock, and stale replay after epoch advancement. Administrative fixtures supply reserved amounts. Actual budget admission and hold conversion, plus the verified settlement writer, remain open in E1. Stage D governs enrollment and lifecycle closure.
