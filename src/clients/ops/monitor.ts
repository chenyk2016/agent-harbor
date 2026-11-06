/** 只报告状态变化；不发送配置、URL、聊天或凭据。失败保留待发送状态供下次重试。 */
import { join } from "node:path";
import { doctor } from "./doctor.js";
import {
  readJson,
  exists,
  privateJson,
  request,
  requireThat,
  type Config,
} from "./common.js";
import { lockSession } from "../../runtime/storage.js";
export async function monitor(c: Config) {
  const release = await lockSession(c.dir);
  try {
    const path = join(c.dir, "monitor-state.json"),
      old = (await exists(path)) ? await readJson(path) : null;
    const report = await doctor(c, { service: true });
    const failures = report.checks
      .filter((x) => x.status === "failed")
      .map((x) => x.name)
      .sort();
    const signature = failures.join(",");
    if (old?.signature === signature)
      return { changed: false, healthy: !failures.length };
    const event = {
      installationId: c.installation.id,
      type: failures.length ? "unhealthy" : "recovered",
      checks: failures,
      at: new Date().toISOString(),
    };
    // 首次健康建立基线，不发送无操作意义的启动通知。
    if (old || failures.length) {
      const hook = c.env.AH_ALERT_WEBHOOK;
      if (hook) {
        const u = new URL(hook);
        requireThat(
          (u.protocol === "https:" ||
            (u.protocol === "http:" &&
              ["127.0.0.1", "localhost"].includes(u.hostname))) &&
            !u.username &&
            !u.password,
          "HTTPS_WEBHOOK_REQUIRED",
        );
        const r = await request(hook, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(c.env.AH_ALERT_WEBHOOK_TOKEN
              ? { Authorization: "Bearer " + c.env.AH_ALERT_WEBHOOK_TOKEN }
              : {}),
          },
          body: JSON.stringify(event),
        });
        requireThat(r.ok, "NOTIFICATION_NOT_CONFIRMED");
      }
      await privateJson(join(c.dir, "last-alert.json"), event);
    }
    await privateJson(path, { signature, sampledAt: report.sampledAt });
    return {
      changed: !!old || !!failures.length,
      healthy: !failures.length,
      delivery: c.env.AH_ALERT_WEBHOOK ? "configured-webhook" : "local-file",
    };
  } finally {
    await release();
  }
}
