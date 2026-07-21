import { z } from 'zod';

export const CreateTagSchema = z.object({
  name: z.string().trim().min(1),
  color: z.string().trim().min(1).optional(),
});
export type CreateTagInput = z.infer<typeof CreateTagSchema>;

export const BulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

export const BulkRetagSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
  add: z.array(z.number().int().positive()).default([]),
  remove: z.array(z.number().int().positive()).default([]),
});
export type BulkRetagInput = z.infer<typeof BulkRetagSchema>;
