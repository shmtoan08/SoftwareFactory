# T1-E1 dispatch storage foundation

The owner authorized starting E1 while revision 2 was in review. Migration 0028 adds immutable reservation identities, chargeable attempts and dispatch events. Existing scheduler and Cost Guard behavior continues through the current paths. [E1 start recorded on issue #23](https://github.com/shmtoan08/SoftwareFactory/issues/23#issuecomment-7101977971)

Reservations can exist independently of a prepared attempt. Project-scoped uniqueness reserves one ordinal per logical invocation and one reservation per attempt. Composite foreign keys enforce project and task consistency across the reserved cost session, lifecycle, lease and optional pipeline session. Attempt epoch, execution and generation references are stored for the authority functions to verify against live state.

Event rows accept PREPARED, then either DISPATCH_STARTED or CONFIRMED_NOT_SENT. A TERMINAL row requires the exact start event as its predecessor. Sequence uniqueness prevents a later no-send event from replacing a recorded start. Every table uses FORCE RLS with no policies, and existing service roles have no grants. The SQL tests use administrative fixtures within a rollback to exercise the constraints and verify write, read and mutation denial.

Migration 0029 adds a same-project ledger foreign key on TERMINAL and a unique index that prevents a finalized ledger from being attached to two attempts. The new index on the business ledger supports that foreign key. Settlement identity checks and HMAC evidence still belong to a later typed writer.

The expiry recovery function requires a project-bound recovery login and a READ COMMITTED transaction. It uses a nonblocking reservation lock. An expired orphan receives an immutable release record. An expired prepared attempt also receives CONFIRMED_NOT_SENT in the same transaction. A recorded start takes precedence over expiry. The migration installs a role group and function ACL, with login and project binding left to provisioning.

Prepare and start must use the reservation lock with seed 2929 and check release evidence. Cost Guard budget holds, active lease validation, exact binding replay, settlement authority and takeover race verification remain open in E1. Stage D's readiness verdict continues to govern enrollment and lifecycle closure.
