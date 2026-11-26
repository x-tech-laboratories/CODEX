// Where drizzle-kit reads the interests' schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/interests/schema.ts", out: "./src/shared/interests/migrations" };
