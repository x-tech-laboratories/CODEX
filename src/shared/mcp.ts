// What an AI client reads first about CODEX, wherever the MCP endpoint runs: the server or the desktop app.

export const mcp_instructions = [
  "CODEX gathers one person's projects and areas of life as contexts, each holding pointers to tasks, notes, files, emails and links that other apps keep.",
  "list_contexts and get_context are the places to start; an item's uri says where it opens, and the item itself stays in its own app.",
  "To add something, find it with search_collector and pass it to add_item, or use add_manual_item for a web link.",
].join(" ");
