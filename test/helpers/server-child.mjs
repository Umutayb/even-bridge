// Child process for test/server-durable.test.mjs: starts the real bridge
// (startServer) with the env the test gives it and reports, on stdout, every
// module load under src/providers/durable/ (so a flag-off run can prove that
// pi-durable was never imported).
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const r = nextResolve(specifier, context);
    if (r.url.includes("/src/providers/durable/")) console.log(`LOADED-DURABLE ${r.url}`);
    return r;
  },
});

const { startServer } = await import("../../src/server.mjs");
await startServer({ cwd: process.env.PROJECT_DIR });
console.log("CHILD-STARTED");
await new Promise(() => {}); // run until the test's SIGTERM
