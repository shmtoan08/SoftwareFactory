# T1-E1 dispatch storage foundation

The owner authorized starting E1 while revision 2 is in review. Migration 0028 adds immutable reservation identities, chargeable attempts and dispatch events. Existing scheduler and Cost Guard behavior continues through the current paths.

Reservations can exist independently of a prepared attempt. Project-scoped uniqueness reserves one ordinal per logical invocation and one reservation per attempt. Composite foreign keys enforce project and task consistency across the reserved cost session, lifecycle, lease and optional pipeline session. Attempt epoch, execution and generation references are stored for the authority functions to verify against live state.

Event rows accept PREPARED, then either DISPATCH_STARTED or CONFIRMED_NOT_SENT. A TERMINAL row requires the exact start event as its predecessor. Sequence uniqueness prevents a later no-send event from replacing a recorded start. Every table uses FORCE RLS with no policies, and existing service roles have no grants. The SQL tests use administrative fixtures within a rollback to exercise the constraints and verify write, read and mutation denial.

The next E1 slice must implement typed authority functions, Cost Guard budget holds and expiry recovery under the scheduler's lease lock order. It must validate binding replay, settlement evidence and takeover races on real PostgreSQL. The storage constraints alone provide no send authorization. Stage D's readiness verdict continues to govern enrollment and lifecycle closure.
