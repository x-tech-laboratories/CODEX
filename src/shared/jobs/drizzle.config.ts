// Where drizzle-kit reads the jobs' schema and writes its migrations; `npm run db:generate` runs it for every feature.
export default { dialect: "sqlite", schema: "./src/shared/jobs/schema.ts", out: "./src/shared/jobs/migrations" };
