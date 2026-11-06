import { z } from "zod";

export const reportInput = z.strictObject({
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  section: z.enum(["overview", "funnel", "quality", "versions"]),
});
export const catalogInput = z.strictObject({});
export const recordsInput = z.strictObject({
  dataset: z.string().max(64),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  columns: z.array(z.string().max(40)).min(1).max(10).optional(),
  limit: z.number().int().min(1).max(25).optional(),
  cursor: z.uuid().optional(),
});
export const toolNames = ["read_report", "list_datasets", "query_records"] as const;
export type AnalysisTool = typeof toolNames[number];
