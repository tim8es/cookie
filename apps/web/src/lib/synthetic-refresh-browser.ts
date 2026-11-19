// Candidate only: no production entrypoint imports this module.
// The fence is a non-authorizing family UUID, never a credential.
const KEY = "kuki-refresh-candidate-fence-v1";
const LOCK = "kuki-refresh-candidate-v1";
const FAMILY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCESS = /^is_[A-Za-z0-9_-]{43}$/;
const PATH = "/v1/auth/synthetic-refresh";

export interface CandidateSession {
  readonly familyId: string;
  readonly accessToken: string;
  readonly expiresAtUnixSeconds: number;
}

type Exclusive = <T>(work: () => Promise<T>) => Promise<T>;

interface BrowserDependencies {
  readonly exclusive: Exclusive;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly fetcher: typeof fetch;
  readonly nowSeconds: () => number;
}

export class CandidateRefreshBrowser {
  private session: CandidateSession | null = null;
  private restoreAttempted = false;

  constructor(private readonly deps: BrowserDependencies) {}

  private fence(): string | null {
    return this.deps.storage.getItem(KEY);
  }

  private setFence(value: string): void {
    this.deps.storage.setItem(KEY, value);
  }

  /** Call on focus/storage/visibility and before displaying protected data. */
  current(): CandidateSession | null {
    const session = this.session;
    if (!session) return null;
    try {
      const fence = this.fence();
      // An interrupted rotation may leave this durable pending fence behind.
      // Hide authority until a confirmed same-family response clears it.
      if (fence === "pending:" + session.familyId) return null;
      if (fence !== session.familyId) {
        this.session = null;
        return null;
      }
      return session.expiresAtUnixSeconds > this.deps.nowSeconds()
        ? { ...session }
        : null;
    } catch {
      this.session = null;
      return null;
    }
  }

  private async request(
    action: "login" | "rotate" | "logout",
    familyId?: string,
    access?: string,
    initData?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { "x-kuki-session": "1" };
    if (familyId) headers["x-kuki-family"] = familyId;
    if (access) headers.authorization = "Bearer " + access;
    if (initData !== undefined) headers["content-type"] = "application/json";
    return this.deps.fetcher(PATH + "/" + action, {
      method: "POST",
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      ...(initData === undefined ? {} : { body: JSON.stringify({ initData }) }),
    });
  }

  private async accept(response: Response, expected?: string) {
    if (response.status !== 200) return null;
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("familyId" in value) ||
      typeof value.familyId !== "string" ||
      !FAMILY.test(value.familyId) ||
      (expected !== undefined && expected !== value.familyId) ||
      !("accessToken" in value) ||
      typeof value.accessToken !== "string" ||
      !ACCESS.test(value.accessToken) ||
      !("expiresAtUnixSeconds" in value) ||
      typeof value.expiresAtUnixSeconds !== "number" ||
      !Number.isSafeInteger(value.expiresAtUnixSeconds) ||
      value.expiresAtUnixSeconds <= this.deps.nowSeconds() ||
      value.expiresAtUnixSeconds > this.deps.nowSeconds() + 3600 ||
      !("tokenType" in value) ||
      value.tokenType !== "Bearer" ||
      !("scope" in value) ||
      value.scope !== "identity" ||
      "refreshToken" in value
    )
      return null;
    const session = {
      familyId: value.familyId,
      accessToken: value.accessToken,
      expiresAtUnixSeconds: value.expiresAtUnixSeconds,
    };
    this.setFence(session.familyId);
    this.session = session;
    return { ...session };
  }

  private async credentials(
    operation: () => Promise<Response>,
    pending: string,
    expected?: string,
  ): Promise<CandidateSession | null> {
    this.session = null;
    // Durable pending state BEFORE any request. A crashed tab or unknown
    // response must never permit automatic replay of a one-use credential.
    this.setFence(pending);
    try {
      const accepted = await this.accept(await operation(), expected);
      if (accepted) return accepted;
    } catch {
      // Includes ambiguous transport/commit and invalid response.
    }
    this.setFence("blocked");
    return null;
  }

  async login(initData: string): Promise<CandidateSession | null> {
    this.restoreAttempted = true;
    return this.deps.exclusive(() =>
      this.credentials(
        () => this.request("login", undefined, undefined, initData),
        "blocked",
      ),
    );
  }

  /** One automatic restore per new controller; a stale controller never adopts. */
  async restore(): Promise<CandidateSession | null> {
    if (this.restoreAttempted) return null;
    this.restoreAttempted = true;
    return this.deps.exclusive(async () => {
      const family = this.fence();
      if (!family || !FAMILY.test(family)) return null;
      return this.credentials(
        () => this.request("rotate", family),
        "pending:" + family,
        family,
      );
    });
  }

  /** Explicit caller chooses lead time; no product TTL or timer default. */
  async renewIfNeeded(leadSeconds: number): Promise<CandidateSession | null> {
    if (!Number.isSafeInteger(leadSeconds) || leadSeconds < 0)
      throw new Error("Invalid renewal lead time");
    return this.deps.exclusive(async () => {
      const current = this.session;
      if (!current || this.fence() !== current.familyId) {
        this.session = null;
        return null;
      }
      if (current.expiresAtUnixSeconds > this.deps.nowSeconds() + leadSeconds)
        return { ...current };
      return this.credentials(
        () => this.request("rotate", current.familyId, current.accessToken),
        "pending:" + current.familyId,
        current.familyId,
      );
    });
  }

  async logout(): Promise<boolean> {
    this.restoreAttempted = true;
    return this.deps.exclusive(async () => {
      const current = this.session;
      this.session = null;
      if (!current || this.fence() !== current.familyId) return false;
      // Block restoration in every tab even when logout cannot be confirmed.
      this.setFence("blocked");
      try {
        const response = await this.request(
          "logout",
          current.familyId,
          current.accessToken,
        );
        return response.status === 204;
      } catch {
        return false;
      }
    });
  }
}

/** Fail closed on WebViews without shared Web Locks or durable fence storage. */
export function createCandidateRefreshBrowser(
  win: Window,
): CandidateRefreshBrowser | null {
  try {
    const locks = win.navigator.locks;
    if (!locks || typeof locks.request !== "function") return null;
    const storage = win.localStorage;
    storage.getItem(KEY);
    return new CandidateRefreshBrowser({
      exclusive: async (work) =>
        await locks.request(LOCK, { mode: "exclusive" }, work),
      storage,
      fetcher: win.fetch.bind(win),
      nowSeconds: () => Math.floor(Date.now() / 1000),
    });
  } catch {
    return null;
  }
}
