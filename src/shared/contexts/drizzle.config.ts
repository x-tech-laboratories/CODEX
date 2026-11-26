// Where drizzle-kit reads the contexts schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/contexts/schema.ts", out: "./src/shared/contexts/migrations" };
