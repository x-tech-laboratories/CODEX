// Where drizzle-kit reads the action policy's schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/policy/schema.ts", out: "./src/shared/policy/migrations" };
