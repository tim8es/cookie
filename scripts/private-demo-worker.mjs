// Private process-to-process control only; deliberately no HTTP route.
export async function runPrivateDemoWorker({ api, lifetimeMs, ready, createProof }) {
  if (!process.connected || typeof process.send !== "function" ||
      !Number.isInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 900000 ||
      api.startFailed || api.exitCode !== null || api.signalCode !== null) {
    throw new Error("Invalid private demo worker context");
  }
  await new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.off("message", onMessage);
      process.off("disconnect", stop);
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      api.off("exit", crash);
      if (error) reject(error); else resolve();
    };
    const stop = () => finish();
    const crash = () => finish(new Error("Private demo API stopped"));
    const send = (message) => {
      if (!process.connected) return stop();
      try { process.send(message, (error) => { if (error) stop(); }); }
      catch { stop(); }
    };
    const onMessage = (message) => {
      if (finished || !message || typeof message !== "object") return;
      if (message.type === "stop") return stop();
      if (message.type !== "proof" || !["owner", "client"].includes(message.role) ||
          !Number.isSafeInteger(message.id) || message.id < 0) return;
      send({ type: "proof", id: message.id, proof: createProof(message.role) });
    };
    const timer = setTimeout(stop, lifetimeMs);
    process.on("message", onMessage);
    process.once("disconnect", stop);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    api.once("exit", crash);
    send({ type: "ready", ...ready });
  }).finally(() => {
    // The supervisor waits for process exit, which follows database cleanup.
    // Disconnect also prevents any new proof issuance after TTL/stop.
    if (process.connected) process.disconnect();
  });
}
