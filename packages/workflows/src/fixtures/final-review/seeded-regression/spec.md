# Seeded regression fixture

Run leases must reject non-positive lease durations and must proceed only after claimRunLease reports that the lease was acquired. A failed claim must throw run_lease_conflict.
