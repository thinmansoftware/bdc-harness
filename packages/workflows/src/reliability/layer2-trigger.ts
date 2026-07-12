export type Layer2CanaryEvent =
  | { readonly type: 'provider_change'; readonly path: string }
  | { readonly type: 'lane_workflow_change'; readonly path: string }
  | { readonly type: 'runtime_revision_change'; readonly revision: string }
  | { readonly type: 'operator_command'; readonly lane: string };

export function shouldRunLayer2Canary(event: Layer2CanaryEvent): boolean {
  switch (event.type) {
    case 'provider_change':
      return event.path.startsWith('packages/providers/');
    case 'lane_workflow_change':
      return event.path.startsWith('.archon/workflows/');
    case 'runtime_revision_change':
      return event.revision.trim().length > 0;
    case 'operator_command':
      return event.lane.trim().length > 0;
  }
}

export function mayStartLayer2Canary(layer1Status: 'pass' | 'warn' | 'block'): boolean {
  return layer1Status === 'pass';
}
