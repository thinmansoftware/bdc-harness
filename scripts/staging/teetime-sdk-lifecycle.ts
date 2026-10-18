// Caller still owns the worker process/container deadline and removal.
// SDK0.153.3 removes child error listeners when its iterator unwinds. Never
// abort that already-closed iterator; a late AbortError can fail the process.
export class ArtifactProviderLifecycle {
  private started = false;
  private isClosed = false;
  private isNormalEnd = false;

  constructor(
    private readonly controller: AbortController,
    private readonly onClosed: () => void
  ) {}

  get closed(): boolean {
    return this.isClosed;
  }
  get normalEnd(): boolean {
    return this.isNormalEnd;
  }

  async *observe<T>(stream: AsyncIterable<T>): AsyncGenerator<T, void, unknown> {
    if (this.started) throw new Error('provider lifecycle cannot be reused');
    this.started = true;
    try {
      for await (const chunk of stream) yield chunk;
    } finally {
      // The underlying iterator has unwound before this finally executes.
      this.isClosed = true;
      this.onClosed();
    }
    // Consumer return/rejection or provider exception cannot reach this line.
    this.isNormalEnd = true;
  }

  abortIfActive(): void {
    if (!this.isClosed) this.controller.abort();
  }
}
