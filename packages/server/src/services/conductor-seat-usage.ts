import { readAllSeats } from '@archon/workflows/reliability/seat-usage';

/** Conductor seat reader. Reuses the harness usage endpoints; no probe of its own. */
export const conductorSeatUsage = (): ReturnType<typeof readAllSeats> => readAllSeats();
