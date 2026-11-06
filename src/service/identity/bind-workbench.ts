/** Local operator command. The PostgreSQL credential and admin configuration are the trust boundary. */
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { identityFromEnvironment } from "../config.js";
import { openDatabase } from "../db/client.js";
import { ServiceError } from "../types.js";
import { IdentityStore } from "./store.js";
import { WorkbenchAuth } from "./workbench.js";

async function main() {
  const [target, credentialFile] = process.argv.slice(2);
  const config = identityFromEnvironment();
  if (!target || !credentialFile || !config.workbench || !config.adminUsers.includes(target))
    throw new Error("Specify a configured Harbor administrator and a private credential JSON file");
  const file = await open(credentialFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: Record<string, unknown>;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096)
      throw new Error("Credential file must be private and at most 4 KiB");
    input = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid credential file");
  const database = openDatabase();
  try {
    const identity = new IdentityStore(database.db);
    await identity.require(target);
    const auth = new WorkbenchAuth(database.pool, config.workbench);
    const subject = await auth.createBindingIdentity(input);
    try {
      await identity.bindWorkbench(subject, target);
    } catch (error) {
      await auth.discardUnboundIdentity(subject);
      throw error;
    }
    console.log("Bound workbench identity to Harbor administrator:", target);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ServiceError ? error.code : "Workbench administrator binding failed; check the configuration and credential file");
  process.exitCode = 1;
});
