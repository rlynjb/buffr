import { db } from "../db/client";
import { conversations, messages } from "../db/schema";
import { eq, asc } from "drizzle-orm";
import { randomUUID } from "crypto";

export interface Conversation {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolCalls?: unknown;
  toolResults?: unknown;
  createdAt: string;
}

export async function createConversation(projectId: string, title?: string): Promise<Conversation> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(conversations).values({
    id,
    projectId,
    title: title ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    projectId,
    title: title ?? null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function addMessage(
  conversationId: string,
  role: Message["role"],
  content: string,
  toolCalls?: unknown,
  toolResults?: unknown,
): Promise<Message> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(messages).values({
    id,
    conversationId,
    role,
    content,
    toolCalls: toolCalls ?? null,
    toolResults: toolResults ?? null,
    createdAt: now,
  });
  // Update conversation updatedAt
  await db.update(conversations)
    .set({ updatedAt: now })
    .where(eq(conversations.id, conversationId));
  return {
    id,
    conversationId,
    role,
    content,
    toolCalls,
    toolResults,
    createdAt: now.toISOString(),
  };
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    role: r.role as Message["role"],
    content: r.content,
    toolCalls: r.toolCalls,
    toolResults: r.toolResults,
    createdAt: r.createdAt.toISOString(),
  }));
}
