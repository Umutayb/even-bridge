// Side-effect import, first in bin/even-bridge.mjs: load ~/.even-terminal/bridge.env
// before the official dist modules evaluate, so settings they read at import
// time (EVEN_TERMINAL_CLAUDE_CODE_EXECUTABLE) come from the file too.
import { startEnvFile } from "./env-file.mjs";

startEnvFile();
