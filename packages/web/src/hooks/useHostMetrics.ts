import { useQuery } from '@tanstack/react-query';
import { getHostMetrics, type HostMetricsResponse } from '@/lib/api';

/**
 * Poll the host metrics endpoint at 30s intervals so the dashboard surfaces
 * live host disk/cpu/mem readings. Mirrors the getHealth() polling pattern
 * (DashboardPage.tsx) -- staleTime 10s, refetchOnWindowFocus, refetchInterval
 * 30s. Returns undefined data while the first request is in flight; the
 * panel handles undefined + 'no-data' status with the same placeholder.
 */
export function useHostMetrics(): {
  data: HostMetricsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['host-metrics'],
    queryFn: getHostMetrics,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });

  return { data, isLoading, isError };
}
