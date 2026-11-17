// Process-local launch policy. The persistent QA database is never a disposable demo.
export function resolveLocalStagingMode(args, ci) {
  const command = args[0] ?? "start";
  if (args.length > 1 || !["start", "stop", "demo", "verify", "verify-demo"].includes(command)) {
    throw new Error("Use start, stop, or demo (verify and verify-demo are CI-only)");
  }
  const verification = command === "verify" || command === "verify-demo";
  if (verification && ci !== "true") {
    throw new Error("The disposable verification mode requires CI=true");
  }
  const demo = command === "demo" || command === "verify-demo";
  return {
    command,
    verification,
    demo,
    disposable: demo || verification,
    folderPrefix: demo ? "manual-staging-demo-" : verification ? "manual-staging-ci-" : "manual-staging",
    projectPrefix: demo ? "cookie-demo-" : verification ? "cookie-manual-ci-" : "cookie-manual-",
  };
}

export function isLocalStagingProject(mode, name) {
  return typeof name === "string" &&
    name.startsWith(mode.projectPrefix) &&
    /^[0-9a-f]{12}$/.test(name.slice(mode.projectPrefix.length));
}

/** Restrict seed credentials to the exact ephemeral loopback API; reject redirects. */
export function localDemoFetch(origin, fetcher = globalThis.fetch) {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      !url.port || url.origin !== origin || url.username || url.password) {
    throw new Error("Demo seeding requires an explicit loopback origin");
  }
  return async (path, init) => {
    if (typeof path !== "string" || !path.startsWith("/v1/")) {
      throw new Error("Only local API paths are permitted");
    }
    const target = new URL(path, origin);
    if (target.origin !== origin || !target.pathname.startsWith("/v1/")) {
      throw new Error("Demo API destination rejected");
    }
    return fetcher(target.href, { ...init, redirect: "error", credentials: "omit" });
  };
}
