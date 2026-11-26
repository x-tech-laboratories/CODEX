// Where drizzle-kit reads the conversations schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/conversations/schema.ts", out: "./src/shared/conversations/migrations" };
