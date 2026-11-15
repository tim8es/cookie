/**
 * Trusted in-process module kernel. It never contains tenant, account or
 * booking policy; domain/platform ports must enforce their own authorization.
 */
export interface CapabilityProvided {
  readonly name: string;
  readonly version: string;
}

export interface CapabilityRequired {
  readonly name: string;
  /** F1 supports exact x.y.z, ^x.y.z, ~x.y.z or *. */
  readonly range: string;
}

export interface ModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly provides?: readonly CapabilityProvided[];
  readonly requires?: readonly CapabilityRequired[];
  /** Non-essential modules may be omitted or fail without stopping the host. */
  readonly optional?: boolean;
}

export interface RegistrationContext {
  provide(name: string, implementation: unknown): void;
}

export interface ModuleContext {
  /** Only explicitly required capabilities may be resolved. */
  resolve<T>(name: string): T;
}

export interface CookieModule {
  readonly manifest: ModuleManifest;
  register(context: RegistrationContext): void;
  start?(context: ModuleContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export type ModuleStatus =
  | "registered"
  | "running"
  | "stopped"
  | "failed"
  | "disabled";

export interface ModuleSnapshot {
  readonly id: string;
  readonly version: string;
  readonly status: ModuleStatus;
}

export interface ModuleKernel {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): readonly ModuleSnapshot[];
}

export class KernelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KernelError";
  }
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

interface Entry {
  readonly module: CookieModule;
  status: ModuleStatus;
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(code: string, message: string): never {
  throw new KernelError(code, message);
}

function versionOf(input: string): Version {
  const match = VERSION_PATTERN.exec(input);
  if (!match)
    return fail("INVALID_MANIFEST", "Invalid semantic version: " + input);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isAtLeast(actual: Version, requested: Version): boolean {
  if (actual.major !== requested.major) return actual.major > requested.major;
  if (actual.minor !== requested.minor) return actual.minor > requested.minor;
  return actual.patch >= requested.patch;
}

function supports(actualVersion: string, range: string): boolean {
  if (range === "*") return true;
  const operator =
    range.startsWith("^") || range.startsWith("~") ? range[0] : "";
  const requestedText = operator ? range.slice(1) : range;
  const actual = versionOf(actualVersion);
  const requested = versionOf(requestedText);
  if (!isAtLeast(actual, requested)) return false;
  if (operator === "^") {
    if (requested.major > 0) return actual.major === requested.major;
    if (requested.minor > 0) {
      return actual.major === 0 && actual.minor === requested.minor;
    }
    return (
      actual.major === 0 &&
      actual.minor === 0 &&
      actual.patch === requested.patch
    );
  }
  if (operator === "~") {
    return actual.major === requested.major && actual.minor === requested.minor;
  }
  return (
    actual.major === requested.major &&
    actual.minor === requested.minor &&
    actual.patch === requested.patch
  );
}

function validate(module: CookieModule): void {
  const { id, version, provides = [], requires = [] } = module.manifest;
  if (!ID_PATTERN.test(id))
    fail("INVALID_MANIFEST", "Invalid module ID: " + id);
  versionOf(version);
  const seenProvided = new Set<string>();
  const seenRequired = new Set<string>();
  for (const capability of provides) {
    if (
      !CAPABILITY_PATTERN.test(capability.name) ||
      seenProvided.has(capability.name)
    ) {
      fail(
        "INVALID_MANIFEST",
        "Invalid or duplicate provided capability in " + id,
      );
    }
    versionOf(capability.version);
    seenProvided.add(capability.name);
  }
  for (const capability of requires) {
    if (
      !CAPABILITY_PATTERN.test(capability.name) ||
      seenRequired.has(capability.name)
    ) {
      fail("INVALID_MANIFEST", "Invalid or duplicate requirement in " + id);
    }
    if (capability.range !== "*") {
      const prefix = /^[~^]/.test(capability.range) ? 1 : 0;
      versionOf(capability.range.slice(prefix));
    }
    seenRequired.add(capability.name);
  }
}

/**
 * Validates the full deployment graph at construction, then starts providers
 * before consumers. Installed code is distinct from tenant entitlements.
 */
export function createKernel(
  modules: readonly CookieModule[],
  options: { readonly disabledModuleIds?: readonly string[] } = {},
): ModuleKernel {
  const entries = new Map<string, Entry>();
  for (const module of modules) {
    validate(module);
    if (entries.has(module.manifest.id)) {
      fail("DUPLICATE_MODULE", "Duplicate module: " + module.manifest.id);
    }
    entries.set(module.manifest.id, { module, status: "registered" });
  }

  const disabled = new Set(options.disabledModuleIds ?? []);
  for (const id of disabled) {
    const entry = entries.get(id);
    if (!entry) fail("UNKNOWN_MODULE", "Cannot disable unknown module: " + id);
    if (!entry.module.manifest.optional) {
      fail("REQUIRED_MODULE", "Cannot disable required module: " + id);
    }
    entry.status = "disabled";
  }

  const providers = new Map<
    string,
    { readonly id: string; readonly version: string }
  >();
  for (const [id, entry] of entries) {
    if (entry.status === "disabled") continue;
    for (const capability of entry.module.manifest.provides ?? []) {
      if (providers.has(capability.name)) {
        fail("DUPLICATE_PROVIDER", "Multiple providers: " + capability.name);
      }
      providers.set(capability.name, { id, version: capability.version });
    }
  }

  const dependencies = new Map<string, string[]>();
  for (const [id, entry] of entries) {
    if (entry.status === "disabled") continue;
    const dependenciesForModule: string[] = [];
    for (const requirement of entry.module.manifest.requires ?? []) {
      const provider = providers.get(requirement.name);
      if (!provider) {
        fail("MISSING_PROVIDER", id + " requires " + requirement.name);
      }
      if (!supports(provider.version, requirement.range)) {
        fail(
          "INCOMPATIBLE_CAPABILITY",
          id + " requires " + requirement.name + " " + requirement.range,
        );
      }
      dependenciesForModule.push(provider.id);
    }
    dependencies.set(id, dependenciesForModule);
  }

  const ordered: Entry[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string, chain: readonly string[]): void => {
    if (visiting.has(id)) {
      fail("DEPENDENCY_CYCLE", "Cycle: " + [...chain, id].join(" -> "));
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      visit(dependency, [...chain, id]);
    }
    visiting.delete(id);
    visited.add(id);
    const entry = entries.get(id);
    if (!entry) fail("UNKNOWN_MODULE", "Missing module: " + id);
    ordered.push(entry);
  };
  for (const id of [...dependencies.keys()].sort()) visit(id, []);

  const capabilities = new Map<string, unknown>();
  let state: "created" | "running" | "stopped" | "failed" = "created";
  const started: Entry[] = [];

  const stopStarted = async (): Promise<unknown[]> => {
    const errors: unknown[] = [];
    for (const entry of [...started].reverse()) {
      try {
        await entry.module.stop?.();
        entry.status = "stopped";
      } catch (error) {
        entry.status = "failed";
        errors.push(error);
      }
    }
    started.length = 0;
    return errors;
  };

  return {
    async start(): Promise<void> {
      if (state !== "created") {
        fail("INVALID_LIFECYCLE", "Kernel can only start once");
      }
      try {
        for (const entry of ordered) {
          const { module } = entry;
          const id = module.manifest.id;
          try {
            module.register({
              provide(name, implementation) {
                if (
                  !(module.manifest.provides ?? []).some(
                    (item) => item.name === name,
                  )
                ) {
                  fail("UNDECLARED_PROVIDER", id + " attempted " + name);
                }
                if (
                  implementation === undefined ||
                  implementation === null ||
                  capabilities.has(name)
                ) {
                  fail(
                    "INVALID_PROVIDER",
                    "Invalid capability implementation: " + name,
                  );
                }
                capabilities.set(name, implementation);
              },
            });
            for (const provided of module.manifest.provides ?? []) {
              if (!capabilities.has(provided.name)) {
                fail(
                  "MISSING_IMPLEMENTATION",
                  id + " did not provide " + provided.name,
                );
              }
            }

            // Providers must already be running; a failed optional provider is unavailable.
            for (const dependency of dependencies.get(id) ?? []) {
              if (entries.get(dependency)?.status !== "running") {
                fail(
                  "UNAVAILABLE_PROVIDER",
                  id + " depends on unavailable module " + dependency,
                );
              }
            }
            await module.start?.({
              resolve<T>(name: string): T {
                if (
                  !(module.manifest.requires ?? []).some(
                    (item) => item.name === name,
                  )
                ) {
                  return fail(
                    "UNDECLARED_REQUIREMENT",
                    id + " cannot resolve " + name,
                  );
                }
                const provider = providers.get(name);
                if (
                  !provider ||
                  entries.get(provider.id)?.status !== "running"
                ) {
                  return fail("UNAVAILABLE_PROVIDER", name + " is not running");
                }
                return capabilities.get(name) as T;
              },
            });
            entry.status = "running";
            started.push(entry);
          } catch (error) {
            entry.status = "failed";
            try {
              await module.stop?.();
            } catch {
              // Best effort cleanup; original startup failure takes precedence.
            }
            if (!module.manifest.optional) throw error;
          }
        }
        state = "running";
      } catch (error) {
        await stopStarted();
        state = "failed";
        throw error;
      }
    },
    async stop(): Promise<void> {
      if (state === "stopped") return;
      if (state !== "running") {
        fail("INVALID_LIFECYCLE", "Kernel is not running");
      }
      const errors = await stopStarted();
      state = "stopped";
      if (errors.length > 0) {
        throw new AggregateError(errors, "One or more modules failed to stop");
      }
    },
    snapshot(): readonly ModuleSnapshot[] {
      return [...entries.values()]
        .map(({ module, status }) => ({
          id: module.manifest.id,
          version: module.manifest.version,
          status,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}
