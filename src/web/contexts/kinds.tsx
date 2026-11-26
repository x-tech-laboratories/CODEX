// How each kind of item looks: its icon and its plain name, such as a tick for a task.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Mail, MessageSquare } from "lucide-react";
import { CheckIcon, FileIcon, FolderIcon, LinkIcon, NotesIcon, type IconGlyph } from "@x-tech-laboratories/x-libs/web/react/icons";

// ── Kinds ────────────────────────────────────────────────────────────────────

interface KindLook {
  icon: IconGlyph;
  // Its name on a card, such as "Task".
  singular: string;
  // Its name as a group heading, such as "Tasks".
  plural: string;
}

const looks: Record<string, KindLook> = {
  task: { icon: CheckIcon, singular: "Task", plural: "Tasks" },
  note: { icon: NotesIcon, singular: "Note", plural: "Notes" },
  email: { icon: Mail, singular: "Email", plural: "Emails" },
  file: { icon: FileIcon, singular: "File", plural: "Files" },
  folder: { icon: FolderIcon, singular: "Folder", plural: "Folders" },
  link: { icon: LinkIcon, singular: "Link", plural: "Links" },
  conversation: { icon: MessageSquare, singular: "Conversation", plural: "Conversations" },
};

// The order kinds are grouped in on a context's page; any other kind comes after these.
export const kind_order = ["task", "note", "email", "file", "folder", "link", "conversation"];

export function look_of(kind: string): KindLook {
  const name = kind.charAt(0).toUpperCase() + kind.slice(1);
  return looks[kind] ?? { icon: FileIcon, singular: name, plural: name };
}
