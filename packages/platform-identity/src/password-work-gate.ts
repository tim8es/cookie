/**
 * Process-local admission control for expensive password KDF operations.
 * Use one shared instance for login, registration and password changes.
 * This is not a distributed per-account or per-address rate limiter.
 */
export class PasswordWorkBusy extends Error {
  constructor() {
    super("Password work capacity exhausted");
    this.name = "PasswordWorkBusy";
  }
}

export class PasswordWorkGate {
  private active = 0;

  constructor(private readonly maxConcurrent: number) {
    if (
      !Number.isSafeInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      maxConcurrent > 4
    ) {
      throw new Error("Invalid password work capacity");
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) throw new PasswordWorkBusy();
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
    }
  }
}
