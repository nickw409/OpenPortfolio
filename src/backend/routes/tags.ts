import { Hono } from 'hono';

import type { Db } from '@backend/db/client';
import { createTag, listTags } from '@backend/services/tags.service';

export interface TagsDeps { db: Db; }

export function createTagsRoute(deps: TagsDeps): Hono {
  return new Hono()
    .get('/', (c) => c.json({ tags: listTags(deps.db) }))
    .post('/', async (c) => c.json({ tag: createTag(deps.db, await c.req.json()) }, 201));
}
