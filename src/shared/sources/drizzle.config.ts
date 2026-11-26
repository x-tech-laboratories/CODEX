// Where drizzle-kit reads the item sources' schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/sources/schema.ts", out: "./src/shared/sources/migrations" };
