// Where drizzle-kit reads the maintenance jobs' schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/maintenance/schema.ts", out: "./src/shared/maintenance/migrations" };
