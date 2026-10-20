import { z } from "zod";

export const ExtractedTaskSchema = z.object({
  summary: z.string().describe("タスクの1行要約"),
  assignee: z.string().nullable().describe("担当者名（推定）"),
  deadline: z.string().nullable().describe("期限（言及があれば）"),
  evidence: z.string().describe("根拠となる発話の引用"),
});

export const TaskExtractionResultSchema = z.object({
  tasks: z.array(ExtractedTaskSchema),
});

export type ExtractedTask = z.infer<typeof ExtractedTaskSchema>;
export type TaskExtractionResult = z.infer<typeof TaskExtractionResultSchema>;
