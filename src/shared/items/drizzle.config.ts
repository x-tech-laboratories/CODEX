// Where drizzle-kit reads the item calls' schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/items/schema.ts", out: "./src/shared/items/migrations" };
