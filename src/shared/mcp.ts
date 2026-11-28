// What an AI client reads first about CODEX, wherever the MCP endpoint runs: the server or the desktop app.

import { prompts } from "./prompts/prompts.ts";

export const mcp_instructions = prompts.mcp.instructions.join(" ");
