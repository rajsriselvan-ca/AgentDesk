import { loadEnvFile } from '@agentdesk/core/load-env';

loadEnvFile();
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/agentdesk',
  },
  strict: true,
  verbose: true,
});
