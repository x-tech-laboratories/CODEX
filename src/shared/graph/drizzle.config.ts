// Where drizzle-kit reads the knowledge graph's schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/graph/schema.ts", out: "./src/shared/graph/migrations" };
