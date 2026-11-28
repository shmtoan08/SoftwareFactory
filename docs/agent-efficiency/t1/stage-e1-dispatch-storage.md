# T1-E1 dispatch storage foundation

The owner authorized starting E1 while revision 2 was in review. Migration 0028 adds immutable reservation identities, chargeable attempts and dispatch events. Existing scheduler and Cost Guard behavior continues through the current paths. [E1 start recorded on issue #23](https://github.com/shmtoan08/SoftwareFactory/issues/23#issuecomment-7101977971)

Reservations can exist independently of a prepared attempt. Project-scoped uniqueness reserves one ordinal per logical invocation and one reservation per attempt. Composite foreign keys enforce project and task consistency across the reserved cost session, lifecycle, lease and optional pipeline session. Attempt epoch, execution and generation references are stored for the authority functions to verify against live state.

Event rows accept PREPARED, then either DISPATCH_STARTED or CONFIRMED_NOT_SENT. A TERMINAL row requires the exact start event as its predecessor. Sequence uniqueness prevents a later no-send event from replacing a recorded start. Every table uses FORCE RLS with no policies, and existing service roles have no grants. The SQL tests use administrative fixtures within a rollback to exercise the constraints and verify write, read and mutation denial.

Migration 0029 adds a same-project ledger foreign key on TERMINAL and a unique index that prevents a finalized ledger from being attached to two attempts. The new index on the business ledger supports that foreign key. Settlement identity checks and HMAC evidence still belong to a later typed writer.

The expiry recovery function requires a project-bound recovery login and a READ COMMITTED transaction. It uses a nonblocking reservation lock. An expired orphan receives an immutable release record. An expired prepared attempt also receives CONFIRMED_NOT_SENT in the same transaction. A recorded start takes precedence over expiry. The migration installs a role group and function ACL, with login and project binding left to provisioning.

Migration 0030 adds project-bound prepare/start functions for the managed worker candidate. Both take the recovery reservation lock with seed 2929, then lock the task and active lease rows with NOWAIT. The managed candidate uses the lease UUID as the execution reference and the active lease epoch as the generation. Reservations without that recorded lease binding are ineligible. Prepare derives the binding digest and verifies task, lifecycle and cost session scope. Start checks release and expiry before appending one start event. A duplicate returns only a receipt. Transport in E2 must require acknowledged commit plus a single-use permit.

For row locking, the function owner receives UPDATE privilege on one identifier column per fenced table. A restrictive RLS policy rejects actual updates by that role. Project-bound service logins receive only function execution. The TypeScript runtime currently has no caller for these functions and the migration provisions no login or fixture reservation in production.

The two-session test covers contention with the task lock, recovery's reservation lock, and stale replay after epoch advancement. Administrative fixtures supply reserved amounts. Migration 0035 adds the cost-session admission gate. Accounting-link, hold conversion, and the verified settlement writer remain open in E1. Stage D governs enrollment and lifecycle closure.

## Cost Guard Reserve (E1 step 1a)

A dedicated, project-bound Cost Guard login calls `telemetry.reserve_dispatch_cost`
on a separate READ COMMITTED connection and commits the outcome before returning
to the outer unit of work. Use a standalone autocommit statement or explicitly
commit the private transaction. The result carries either the reservation and
attempt identifiers with a five-minute server expiry or the committed blocked
ledger identifier. An outer rollback has no effect on this commit. A rollback
of the Reserve transaction itself loses its writes. An ambiguous commit denies
transport. Invalid identity, inaccessible state, and technical errors abort
admission. Only an evaluated budget denial can produce a truthful
`BLOCKED_PREFLIGHT` row.

The cost-session row lock serializes admissions with other admissions and
existing session-accounting writes. Released reservations are excluded.
Expiry frees an unstarted hold only when Reserve acquires the same reservation
fence as start and confirms there is no durable start. Lock contention and an
expired started attempt preserve the hold. No ledger is inferred to be a
conversion receipt. Used totals may therefore conservatively count a finalized
charge alongside its open hold until 1b provides the accounting link.

### E2 entry conditions

- Claude decides the order of the two required gates when E2 connects composition.
- Integration tests prove an enrolled call goes through both gates and cover each gate rejecting independently.
- E2 explicitly decides how to handle auto-pause when Reserve is the rejecting gate.
- E2 proves the executor carries the exact server-issued reservation for its attempt.
- SQL and TypeScript both write `BLOCKED_PREFLIGHT`. Keep the 1a whole-row parity test as the regression guard against format drift.
