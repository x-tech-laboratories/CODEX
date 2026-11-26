// Links such as codex://context/<id>, which open the desktop app on that page from a notification or any other
// program.

// ── Links ────────────────────────────────────────────────────────────────────

export const link_scheme = "codex";

const link_pattern = /^codex:\/\/([a-z0-9/_-]*)$/i;

// The link to a page, given its route such as "#/context/<id>".
export function app_link(route: string): string {
  return `${link_scheme}://${route.replace(/^#?\/?/, "")}`;
}

// The page's route a link names, such as "#/context/<id>", or null when the text is not one of the app's links; an
// entity's link, codex://entity/<id>, opens the Graph page on it.
export function route_of_link(text: string): string | null {
  const path = link_pattern.exec(text)?.[1]?.replace(/\/+$/, "");
  if (path === undefined) return null;
  const entity = /^entity\/([^/]+)$/i.exec(path)?.[1];
  return entity ? `#/graph/${encodeURIComponent(`entity:${entity}`)}` : `#/${path}`;
}
