/** 本机签名身份服务夹具：完整重定向/换码/JWKS验证，不访问任何真实账号。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import * as client from "openid-client";
import { OidcLogin } from "../src/service/identity/oidc.js";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
test("OIDC PKCE, nonce, state, issuer/audience/signature and one-time browser binding", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const badKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  let origin = "", mode = "good", exchanges = 0;
  const codes = new Map<string, URLSearchParams>();
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url!, origin);
    if (url.pathname === "/authorize") {
      const code = String(codes.size + 1); codes.set(code, url.searchParams);
      response.writeHead(302, { Location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}` }); response.end(); return;
    }
    if (url.pathname === "/jwks") {
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ keys: [{ ...publicKey.export({format:"jwk"}), kid:"fixture", use:"sig", alg:"RS256" }] })); return;
    }
    if (url.pathname === "/token") {
      exchanges++;let raw="";for await (const chunk of request) raw+=chunk;
      const body=new URLSearchParams(raw), saved=codes.get(body.get("code")!);
      assert.ok(saved);assert.equal(body.get("client_id"),"harbor");assert.equal(body.get("client_secret"),"fixture-secret");
      assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), saved.get("code_challenge"));
      const header=encode({alg:"RS256",kid:"fixture"});
      const claims=encode({iss:mode==="issuer"?"https://wrong.invalid":origin,sub:"person-1",aud:mode==="audience"?"wrong":"harbor",nonce:mode==="nonce"?"wrong":saved.get("nonce"),iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+(mode==="expired"?-1000:300),name:"Example User"});
      const jwt=`${header}.${claims}.${sign("RSA-SHA256",Buffer.from(`${header}.${claims}`),mode==="signature"?badKey:privateKey).toString("base64url")}`;
      response.setHeader("Content-Type","application/json");response.end(JSON.stringify({access_token:"fixture-not-persisted",token_type:"Bearer",id_token:jwt}));return;
    }
    if (url.pathname === "/start") { await login.start(response);return; }
    if (url.pathname === "/api/auth/oidc/callback") {
      try { const user=await login.callback(request,response);response.end(JSON.stringify(user)); }
      catch { response.statusCode=401;response.end("denied"); }return;
    }
    response.statusCode=404;response.end();
  })().catch(error=>{response.statusCode=500;response.end(String(error));}); });
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const config = new client.Configuration({issuer:origin,authorization_endpoint:origin+"/authorize",token_endpoint:origin+"/token",jwks_uri:origin+"/jwks"},"harbor","fixture-secret",client.ClientSecretPost("fixture-secret"));
  // 只有测试注入的本机供应商允许HTTP；正式配置校验不提供这个开关。
  client.allowInsecureRequests(config);
  const login=new OidcLogin({issuer:origin,clientId:"harbor",clientSecret:"fixture-secret",origin},async()=>config);
  async function begin() {
    const start=await fetch(origin+"/start",{redirect:"manual"});assert.equal(start.status,302);
    const cookie=start.headers.get("set-cookie")!.split(";")[0],auth=new URL(start.headers.get("location")!);
    assert.equal(auth.searchParams.get("code_challenge_method"),"S256");assert.ok(auth.searchParams.get("state"));assert.ok(auth.searchParams.get("nonce"));
    const redirected=await fetch(auth,{redirect:"manual"});return {cookie,callback:redirected.headers.get("location")!};
  }
  try {
    const good=await begin(),result=await fetch(good.callback,{headers:{Cookie:good.cookie}});
    assert.equal(result.status,200);assert.deepEqual(await result.json(),{issuer:origin,subject:"person-1",name:"Example User"});
    assert.equal((await fetch(good.callback,{headers:{Cookie:good.cookie}})).status,401);
    const state=await begin(),badState=new URL(state.callback);badState.searchParams.set("state","wrong");const before=exchanges;
    assert.equal((await fetch(badState,{headers:{Cookie:state.cookie}})).status,401);assert.equal(exchanges,before);
    const binding=await begin();assert.equal((await fetch(binding.callback)).status,401);
    for (mode of ["nonce","audience","issuer","signature","expired"]) {
      const flow=await begin();assert.equal((await fetch(flow.callback,{headers:{Cookie:flow.cookie}})).status,401,mode);
    }
  } finally { server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done())); }
});
