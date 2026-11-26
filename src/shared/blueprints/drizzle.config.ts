// Where drizzle-kit reads the blueprints' schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/blueprints/schema.ts", out: "./src/shared/blueprints/migrations" };
