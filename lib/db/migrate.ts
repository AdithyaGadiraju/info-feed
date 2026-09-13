import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { closeDb, db, dashboardUrl, isProjectPausedError } from './client';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Applies `schema.sql`. Every statement is `IF NOT EXISTS`, so this is safe to run
 * on every `npm run digest` and as often as you like. There is no migration table
 * and no down-migrations; the file is the schema (ADR 0001).
 */
export async function migrate(): Promise<void> {
  const sql = db();
  const schema = await readFile(join(here, 'schema.sql'), 'utf8');
  await sql.unsafe(schema);
}

// Cross-platform main check: pathToFileURL handles Windows drive paths (ADR 0001: mac + windows).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  migrate()
    .then(() => {
      console.log('Schema applied.');
      return closeDb();
    })
    .catch(async (err) => {
      if (isProjectPausedError(err)) {
        console.error(`Supabase project paused, resume it at ${dashboardUrl()}`);
      } else {
        console.error('Migration failed:', err);
      }
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
