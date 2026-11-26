// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261126111910_start",
    "statements": [
      "CREATE TABLE `item_marks` (\n\t`kind` text NOT NULL,\n\t`id` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\t`changed_at` text NOT NULL,\n\tCONSTRAINT `item_marks_pk` PRIMARY KEY(`kind`, `id`)\n);"
    ]
  }
];
