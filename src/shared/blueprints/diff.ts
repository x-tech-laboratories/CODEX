// What differs between two texts, line by line, so a proposed change to a blueprint shows what it adds and takes away.

// ── Diff ─────────────────────────────────────────────────────────────────────

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

// The lines of both texts in order, each kept, added or removed, by their longest common run of lines.
export function line_diff(before: string, after: string): DiffLine[] {
  const old_lines = before.split("\n");
  const new_lines = after.split("\n");
  const longest = Array.from({ length: old_lines.length + 1 }, () => Array.from({ length: new_lines.length + 1 }, () => 0));
  for (let old_at = old_lines.length - 1; old_at >= 0; old_at--) {
    for (let new_at = new_lines.length - 1; new_at >= 0; new_at--) {
      longest[old_at]![new_at] = old_lines[old_at] === new_lines[new_at] ? longest[old_at + 1]![new_at + 1]! + 1 : Math.max(longest[old_at + 1]![new_at]!, longest[old_at]![new_at + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let old_at = 0;
  let new_at = 0;
  while (old_at < old_lines.length && new_at < new_lines.length) {
    if (old_lines[old_at] === new_lines[new_at]) {
      lines.push({ kind: "same", text: old_lines[old_at]! });
      old_at++;
      new_at++;
    } else if (longest[old_at + 1]![new_at]! >= longest[old_at]![new_at + 1]!) lines.push({ kind: "removed", text: old_lines[old_at++]! });
    else lines.push({ kind: "added", text: new_lines[new_at++]! });
  }
  while (old_at < old_lines.length) lines.push({ kind: "removed", text: old_lines[old_at++]! });
  while (new_at < new_lines.length) lines.push({ kind: "added", text: new_lines[new_at++]! });
  return lines;
}
