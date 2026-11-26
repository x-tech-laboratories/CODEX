// Where drizzle-kit reads the privacy feature's schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/privacy/schema.ts", out: "./src/shared/privacy/migrations" };
