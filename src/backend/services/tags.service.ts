import type { Db } from '@backend/db/client';
import { tags } from '@backend/db/schema';
import { activeWhere } from '@backend/db/soft-delete';
import { CreateTagSchema } from '@shared/schemas/tag';

export type TagRow = typeof tags.$inferSelect;

export function listTags(db: Db): TagRow[] {
  return db.select().from(tags).where(activeWhere(tags, undefined)).all();
}

export function createTag(db: Db, raw: unknown): TagRow {
  const input = CreateTagSchema.parse(raw);
  return db
    .insert(tags)
    .values({ name: input.name, color: input.color ?? null })
    .returning()
    .get();
}
