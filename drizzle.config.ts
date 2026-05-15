import type { Config } from 'drizzle-kit';

export default {
  schema: './src/backend/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/openportfolio.sqlite',
  },
} satisfies Config;
