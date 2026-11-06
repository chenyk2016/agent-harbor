import { randomUUID } from "node:crypto";

/** 自定义业务只注册当前应用路由；监听、数据身份与观测由固定Runtime管理。 */
/** 平台注入的业务观测能力：在业务事务中写成功事件，并从请求提取经过约束的关联上下文。 */
type AnalyticsContext = {
  /** 将业务写入和成功事件放入同一事务；业务回滚时成功事件也不提交。 */
  transaction<T>(
    work: (
      client: any,
      emit: (
        name: string,
        properties?: Record<string, unknown>,
        context?: Record<string, string>,
      ) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
  /** 从请求提取事件关联信息，供事务内 emit 使用。 */
  context(request: any): Record<string, string>;
};
/** 向平台提供的路由器注册自定义业务接口；监听端口、数据身份和通用数据接口由固定 Runtime 管理。 */
export function register(
  router: any,
  context: { revisionId: string; analytics: AnalyticsContext },
) {
  router.get("/api/about", (_request: any, response: any) =>
    response.json({ title: "活动报名", revisionId: context.revisionId }),
  );
  router.post("/api/signup", async (request: any, response: any) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const email = typeof request.body?.email === "string" ? request.body.email.trim() : "";
    if (!name || name.length > 80 || email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return response.status(400).json({ error: "INVALID_SIGNUP" });
    const id = randomUUID();
    await context.analytics.transaction(async (client, emit) => {
      await client.query("INSERT INTO signups (id,name,email) VALUES ($1,$2,$3)", [id, name, email]);
      await emit("signup_succeeded", {}, context.analytics.context(request));
    });
    response.status(201).json({ id });
  });
}
