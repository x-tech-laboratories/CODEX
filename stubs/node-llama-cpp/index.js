// CODEX installs SmartHarness without node-llama-cpp, so loading a GGUF file through SmartHarness is refused plainly.
throw new Error("CODEX's SmartHarness engine has no local llama.cpp: it reaches a model through an OpenAI-compatible endpoint. Point it at a llama.cpp server or Ollama under Settings → Plugins.");
