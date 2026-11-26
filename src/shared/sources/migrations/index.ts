// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261126112604_start",
    "statements": [
      "CREATE TABLE `item_source_cursors` (\n\t`source_id` text PRIMARY KEY,\n\t`cursor` text NOT NULL,\n\t`updated_at` text NOT NULL\n);"
    ]
  }
];
