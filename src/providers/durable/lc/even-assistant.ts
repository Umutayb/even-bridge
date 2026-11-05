// even-assistant: the Even AI assistant's pi extension, loaded into the `dur-assistant` child with `-e`
// (plan Task A2; the bridge's assistantLaunch in launch.mjs). Tools from the shim's tool server over
// HTTP, stale phone data stubbed, cut requests neutralised, a per-run tool cap, memory writes only on
// request, host notes through `/even-note <file>`. All of it lives in assistant-ext-core.mjs; this file
// only hands pi to it. Env (set by the bridge): EVEN_ASSISTANT_TOOLS_URL, EVEN_ASSISTANT_TOOLS_TOKEN_FILE,
// EVEN_ASSISTANT_SCHEMA_CACHE, optional EVEN_ASSISTANT_LOG.
import { setupAssistantExtension } from "./assistant-ext-core.mjs";

export default async function (pi: any) {
  await setupAssistantExtension(pi);
}
