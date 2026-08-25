# Manage coordination as baseline infrastructure

Study 1 owns a separate CDK entry point and explicit operator commands for the coordination resource, but probes and runs may only verify and use its frozen identity and schema; they never provision, migrate, destroy, clean up, or attribute it as run-owned cost. Bootstrap, migration, and destruction remain deliberate operator actions, with destruction refused while any active, non-stale, or recovery-required lease exists.
