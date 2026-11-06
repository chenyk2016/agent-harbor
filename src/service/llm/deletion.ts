import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import {
  llmBindings, llmDeployments, llmModelVersions, llmProviders, messages, sessions,
} from "../db/schema/index.js";
import { activeStatuses, fail } from "../types.js";

type Reader = Database | Tx;

/** 与删除的行锁互斥，防止选好模型后才提交会话、消息或个人默认。 */
export async function lockDeploymentForUse(tx: Tx, id: string) {
  const [row] = await tx.select().from(llmDeployments).where(eq(llmDeployments.id, id)).for("share");
  if (!row || row.deletionState) fail(409, "MODEL_UNAVAILABLE");
  return row;
}

export async function lockProviderForUse(tx: Tx, id: string) {
  const [row] = await tx.select().from(llmProviders).where(eq(llmProviders.id, id)).for("share");
  if (!row || row.deletedAt !== null) fail(404, "PROVIDER_NOT_FOUND");
}

export async function deploymentSessionCount(db: Reader, id: string) {
  const references = db.select({ id: sessions.id }).from(sessions)
    .where(sql`${sessions.modelSnapshot}->>'deploymentId' = ${id}`)
    .union(db.select({ id: llmBindings.sessionId }).from(llmBindings)
      .where(and(eq(llmBindings.deploymentId, id), ne(llmBindings.state, "revoked"))))
    .union(db.select({ id: messages.sessionId }).from(messages)
      .where(and(inArray(messages.status, activeStatuses), sql`${messages.modelSnapshot}->>'deploymentId' = ${id}`)))
    .as("references");
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(references);
  return row.count;
}

export async function providerModelCount(db: Reader, id: string) {
  const [row] = await db.select({ count: sql<number>`count(distinct ${llmDeployments.id})::int` })
    .from(llmModelVersions)
    .innerJoin(llmDeployments, eq(llmModelVersions.deploymentId, llmDeployments.id))
    .where(and(eq(llmModelVersions.providerId, id), sql`${llmDeployments.deletionState} is distinct from 'deleted'`));
  return row.count;
}
