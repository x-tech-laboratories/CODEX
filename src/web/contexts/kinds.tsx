// How each kind of item looks: its icon and its plain name, such as a clipboard for a task; and a task's row icon, an
// empty circle while open and a ticked one once done, so the kind's icon is never taken for done.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Circle, CircleCheckBig, ClipboardList, Lightbulb, Mail, MessageSquare, ScrollText } from "lucide-react";
import { FileIcon, FolderIcon, LinkIcon, NotesIcon, type IconGlyph } from "@x-tech-laboratories/x-libs/web/react/icons";

// ── Kinds ────────────────────────────────────────────────────────────────────

interface KindLook {
  icon: IconGlyph;
  // Its name on a card, such as "Task".
  singular: string;
  // Its name as a group heading, such as "Tasks".
  plural: string;
}

const looks: Record<string, KindLook> = {
  task: { icon: ClipboardList, singular: "Task", plural: "Tasks" },
  note: { icon: NotesIcon, singular: "Note", plural: "Notes" },
  email: { icon: Mail, singular: "Email", plural: "Emails" },
  file: { icon: FileIcon, singular: "File", plural: "Files" },
  folder: { icon: FolderIcon, singular: "Folder", plural: "Folders" },
  link: { icon: LinkIcon, singular: "Link", plural: "Links" },
  conversation: { icon: MessageSquare, singular: "Conversation", plural: "Conversations" },
  blueprint: { icon: ScrollText, singular: "Blueprint", plural: "Blueprints" },
  finding: { icon: Lightbulb, singular: "Finding", plural: "Findings" },
};

// The order kinds are grouped in on a context's page; any other kind comes after these.
export const kind_order = ["task", "note", "email", "file", "folder", "link", "conversation", "blueprint", "finding"];

export function look_of(kind: string): KindLook {
  const name = kind.charAt(0).toUpperCase() + kind.slice(1);
  return looks[kind] ?? { icon: FileIcon, singular: name, plural: name };
}

// The icon leading an item's row: a task's says whether it is done, with words for a screen reader; any other kind's
// is its kind's.
export function row_icon(kind: string, status: string): { icon: IconGlyph; label?: string; class_name?: string } {
  if (kind !== "task") return { icon: look_of(kind).icon };
  return status === "done" ? { icon: CircleCheckBig, label: "Done task", class_name: "tone-good" } : { icon: Circle, label: "Open task", class_name: "muted" };
}
