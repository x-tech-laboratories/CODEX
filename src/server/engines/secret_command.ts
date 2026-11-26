// Runs a command that prints a secret, such as a password manager's, so the settings name the program and never hold
// the secret. The secret lives in memory only while one run needs it, and no failure message carries what it printed.

// ── Imports ──────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";

// ── Commands ─────────────────────────────────────────────────────────────────

const secret_timeout_ms = 10_000;
export const max_secret_chars = 1024;

export type SecretReader = (command: string[]) => Promise<string>;

// A command line split into words as a shell would, with single and double quotes and backslashes, but nothing expanded.
export function command_words(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let has_word = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (char === "\\" && index + 1 < line.length && (quote === null || /["\\$`]/.test(line[index + 1]!))) {
      word += line[(index += 1)];
      has_word = true;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      has_word = true;
    } else if (/\s/.test(char)) {
      if (has_word) words.push(word);
      word = "";
      has_word = false;
    } else {
      word += char;
      has_word = true;
    }
  }
  if (quote) throw new Error("The API key command has a quote that is never closed.");
  if (has_word) words.push(word);
  return words;
}

// The first line the program prints; a failure, an empty line or an overlong one is refused in words of our own.
export const read_secret: SecretReader = ([program, ...args]) =>
  new Promise((resolve, reject) => {
    if (!program) return reject(new Error("The API key command is empty."));
    execFile(program, args, { timeout: secret_timeout_ms, maxBuffer: max_secret_chars * 4, encoding: "utf8" }, (error, stdout) => {
      if (error) return reject(new Error(`The API key command ${program} failed${typeof error.code === "number" ? ` with exit code ${error.code}` : ""}.`));
      const secret = stdout.split("\n")[0]!.replace(/\r$/, "");
      if (!secret || secret.length > max_secret_chars) return reject(new Error(`The API key command ${program} printed no usable key.`));
      resolve(secret);
    });
  });

// The key the setting's command prints, or none when no command is set.
export async function key_from(command_line: string, read: SecretReader = read_secret): Promise<string> {
  const words = command_words(command_line.trim());
  return words.length === 0 ? "" : read(words);
}
