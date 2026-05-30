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
  stream: z.boolean().optional(),
  data: z.unknown().optional()
});

export const todoPrioritizeSchema = z.object({
  today: z.string().max(20).optional(),
  todos: z.array(z.object({
    id: z.string().min(1),
    title: z.string().max(300).optional(),
    description: z.string().max(3000).optional(),
    dueAt: z.string().max(80).optional(),
    priority: z.enum(['low', 'middle', 'high']).optional(),
    status: z.enum(['open', 'done']).optional(),
    ownerName: z.string().max(120).optional(),
    remindAt: z.string().max(80).optional(),
    reminderEnabled: z.boolean().optional(),
    createdAt: z.string().max(80).optional(),
    updatedAt: z.string().max(80).optional(),
    completedAt: z.string().max(80).optional()
  })).max(200),
  events: z.array(z.object({
    id: z.string().optional(),
    title: z.string().max(300).optional(),
    startAt: z.string().max(80).optional(),
    endAt: z.string().max(80).optional(),
    location: z.string().max(300).optional()
  })).max(100).optional()
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
