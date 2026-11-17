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
