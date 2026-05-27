import { z } from 'zod';

export const sourceTypeSchema = z.enum(['diary', 'event', 'todo', 'expense', 'anniversary', 'sharedNote']);

export const ragUpsertSchema = z.object({
  id: z.string().min(1),
  type: sourceTypeSchema,
  userId: z.string().min(1).optional(),
  ownerName: z.string().optional(),
  groupId: z.string().min(1),
  spaceId: z.string().optional(),
  spaceName: z.string().optional(),
  visibility: z.enum(['private', 'shared']).optional(),
  aiReadable: z.boolean().optional(),
  date: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const ragBatchSchema = z.object({
  items: z.array(ragUpsertSchema).max(300)
});

export const ragDeleteSchema = z.object({
  type: sourceTypeSchema,
  id: z.string().min(1)
});

export const textBodySchema = z.object({
  text: z.string().max(10000).default('')
});

export const askBodySchema = z.object({
  question: z.string().min(1).max(2000),
  partnerName: z.string().max(80).optional(),
  partnerRelationship: z.string().max(80).optional(),
  currentUserId: z.string().optional(),
  groupId: z.string().optional(),
  spaceIds: z.array(z.string().min(1)).max(30).optional(),
  chatHistory: z.array(z.object({
    role: z.enum(['user', 'ai']),
    content: z.string().max(4000)
  })).max(12).optional(),
  data: z.unknown().optional()
});

export const receiptBodySchema = z.object({
  imageUrl: z.string().url()
});

export const pushSendSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(1000),
  url: z.string().max(500).default('/'),
  userId: z.string().optional()
});

export function validationError(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({ error: 'invalid_request', details: error.flatten() }, { status: 400 });
  }
  return null;
}
