/** 0013 用旧结构数据回填部署/版本/价格，并删除旧列；不依赖服务启动。 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { testDatabaseUrl } from "./pg.js";

test("0013 backfills deployments, versions, prices and request attribution from the legacy model row", async () => {
  const schema = `ah_mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: testDatabaseUrl,
    max: 1,
    options: `-c search_path=${schema}`,
  });
  const folder = resolve("migrations");
  try {
    const files = (await readdir(folder)).filter((file) => file.endsWith(".sql")).sort();
    const migration = "0013_llm_deployment_versioning.sql";
    for (const file of files.filter(file => file < migration)) {
      await pool.query(await readFile(resolve(folder, file), "utf8"));
    }
    const snapshot = JSON.stringify({
      id: "m",
      name: "Model",
      provider: "Provider",
      alias: "alias-m",
    });
    await pool.query(`INSERT INTO users(id,name,disabled,"createdAt") VALUES ('u','User',0,1)`);
    await pool.query(`INSERT INTO sessions(id,"ownerId",title,"createdAt","updatedAt","modelSnapshot") VALUES ('s','u','Session',1,1,$1::jsonb)`, [snapshot]);
    await pool.query(`INSERT INTO messages(id,"sessionId","clientMessageId",text,status,"requestedModelId","modelSnapshot","activatedModelSnapshot","createdEventId") VALUES ('msg','s','client-message','hi','succeeded','m',$1::jsonb,$1::jsonb,1)`, [snapshot]);
    await pool.query(`INSERT INTO llm_providers(id,name,"apiBase",format,secret,"createdAt") VALUES ('p','Provider','https://example.invalid','openai_chat','sealed-secret',1)`);
    await pool.query(`INSERT INTO llm_models(id,"providerId",name,description,"upstreamModel",alias,enabled,tools,streaming,"allowedUsers",state,"createdAt",price) VALUES ('m','p','Model','legacy','upstream-model','alias-m',true,true,true,'["u"]'::jsonb,'ready',1,'{"input":1000000,"output":2000000,"cacheRead":300000,"cacheWrite":400000}'::jsonb)`);
    await pool.query(`INSERT INTO llm_bindings(id,"sessionId","ownerId","modelId",secret,state,"expiresAt","walletTokenHash") VALUES ('b','s','u','m','sealed-binding','active',NULL,'wallet-hash')`);
    await pool.query(`INSERT INTO llm_preferences("ownerId","modelId") VALUES ('u','m')`);
    await pool.query(`INSERT INTO wallet_requests(id,"userId","sessionId","modelId","modelName",price,reserved,state,note,"createdAt") VALUES ('w','u','s','m','Model','{"input":1000000,"output":2000000,"cacheRead":300000,"cacheWrite":400000}'::jsonb,10,'settled','',1)`);
    await pool.query(`INSERT INTO gateway_usage_events(id,"callId","ownerId","sessionId",model,status,"pricingKnown","startedAt","observedAt") VALUES ('g','call','u','s','alias-m','success',true,1,1)`);
    for (const file of files.filter(file => file >= migration)) {
      await pool.query(await readFile(resolve(folder, file), "utf8"));
    }

    const provider = (await pool.query(`SELECT * FROM llm_providers`)).rows[0];
    assert.equal(provider.secret, undefined, "plaintext secret column is removed");
    const secret = (await pool.query(`SELECT * FROM llm_provider_secrets`)).rows[0];
    assert.equal(secret.secret, "sealed-secret");
    assert.equal(secret.version, 1);
    const deployment = (await pool.query(`SELECT * FROM llm_deployments`)).rows[0];
    assert.equal(deployment.id, "m");
    assert.equal(deployment.currentVersionId, "m");
    assert.deepEqual(deployment.allowedUsers, ["u"]);
    const version = (await pool.query(`SELECT * FROM llm_model_versions`)).rows[0];
    assert.equal(version.id, "m");
    assert.equal(version.deploymentId, "m");
    assert.equal(version.routeName, "alias-m");
    assert.equal(version.upstreamModel, "upstream-model");
    assert.equal(version.state, "ready");
    const price = (await pool.query(`SELECT * FROM llm_deployment_prices`)).rows[0];
    assert.equal(price.id, "price-m");
    assert.equal(Number(price.input), 1000000);
    const binding = (await pool.query(`SELECT * FROM llm_bindings`)).rows[0];
    assert.equal(binding.deploymentId, "m");
    assert.equal(binding.versionId, "m");
    assert.equal(binding.modelId, undefined);
    const preference = (await pool.query(`SELECT * FROM llm_preferences`)).rows[0];
    assert.equal(preference.deploymentId, "m");
    const session = (await pool.query(`SELECT "modelSnapshot" FROM sessions`)).rows[0].modelSnapshot;
    assert.deepEqual(session, {
      deploymentId: "m",
      deploymentName: "Model",
      versionId: "m",
      providerName: "Provider",
      upstreamModel: "upstream-model",
      routeName: "alias-m",
    });
    const message = (await pool.query(`SELECT "requestedDeploymentId", "modelSnapshot", "activatedModelSnapshot" FROM messages`)).rows[0];
    assert.equal(message.requestedDeploymentId, "m");
    assert.equal(message.modelSnapshot.deploymentId, "m");
    assert.equal(message.activatedModelSnapshot.routeName, "alias-m");
    const request = (await pool.query(`SELECT * FROM wallet_requests`)).rows[0];
    assert.equal(request.deploymentId, "m");
    assert.equal(request.versionId, "m");
    assert.equal(request.priceVersionId, "price-m");
    assert.equal(request.modelId, undefined);
    const event = (await pool.query(`SELECT * FROM gateway_usage_events`)).rows[0];
    assert.equal(event.deploymentId, "m");
    assert.equal(event.versionId, "m");
    await assert.rejects(pool.query("SELECT * FROM llm_models"), /does not exist/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM llm_model_costs")).rows[0].n, 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
