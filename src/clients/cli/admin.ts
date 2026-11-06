/** 薄管理客户端：只通过已认证服务修改用户，不旁路打开正在使用的数据库。 */
import { ServiceClient } from "../service-client.js";
const [action, userId, json] = process.argv.slice(2);
const api = new ServiceClient(process.env.AH_SERVICE_URL ?? "http://127.0.0.1:4318", process.env.AH_SERVICE_TOKEN ?? "");
if (action === "list") console.log(JSON.stringify(await api.request("/admin/users"), null, 2));
else if (action === "update" && userId && json) console.log(JSON.stringify(await api.request(`/admin/users/${encodeURIComponent(userId)}`, "PATCH", JSON.parse(json)), null, 2));
else throw new Error('Usage: npm run admin -- list | update USER_ID \'{"disabled":true}\'');
