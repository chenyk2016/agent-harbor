import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationApi } from "../apps/web/src/state/application-api.js";
import { messageFeedback } from "../apps/web/src/state/task-feedback.js";
import { ConversationState } from "../apps/web/src/state/conversation-state.js";
import type { Message } from "../src/service/types.js";
import type { SessionDetail } from "../src/clients/service-client.js";
const message = { id:"m",sessionId:"s",clientMessageId:"c",text:"task",status:"cancelled",cancelRequested:0,createdEventId:1,startedAt:10,finishedAt:20,result:null } as Message;

test("historical interruption never claims the user cancelled; timeout has a distinct cause", () => {
  assert.equal(messageFeedback(message)?.title, "本轮已中断");
  assert.equal(messageFeedback({...message,cancelRequested:1})?.title,"本轮已停止");
  const timeout = messageFeedback({...message,status:"failed",result:JSON.stringify({error:"TASK_TIMEOUT",reason:"task_timeout"})});
  assert.equal(timeout?.title,"本轮执行超时");
  assert.match(timeout!.description,/执行时限/);
  assert.equal(messageFeedback({...message,status:"succeeded"}),undefined);
  assert.equal(messageFeedback({...message,result:JSON.stringify({reason:"environment_closed"})})?.title,"工作环境已关闭");
});

test("application retries retain the model and revision of the first attempt", async () => {
  let head="revision-a";
  const values = new Map<string,string>();
  const storage = {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)}} as Storage;
  const api=new ApplicationApi("app",()=>head,storage); api.bindUser("alice");
  const bodies:unknown[]=[];
  api.request=async <T>(_path:string,_method?:string,body?:unknown):Promise<T> => { bodies.push(body);return {message} as T; };
  await api.send("s","same-request","task","model-a");
  head="revision-b";
  await api.send("s","same-request","task","model-b");
  assert.deepEqual(bodies[1],bodies[0]);
  assert.deepEqual(bodies[0],{clientMessageId:"same-request",text:"task",modelDeploymentId:"model-a",expectedHeadRevisionId:"revision-a"});
  const refreshed = new ApplicationApi("app",()=>head,storage); refreshed.bindUser("alice");
  refreshed.request = api.request;
  await refreshed.send("s","same-request","task","model-b");
  assert.deepEqual(bodies[2],bodies[0],"refresh must retain original model and revision");
  await api.send("s","new-request","task","model-b");
  assert.equal((bodies[3] as {modelDeploymentId:string}).modelDeploymentId,"model-b");
});

test("live lifecycle timestamps are retained, so finished durations stop advancing", () => {
  const state=new ConversationState({id:"s",lastMessageId:"m",lastEventId:0} as SessionDetail);
  state.add({...message,startedAt:null,finishedAt:null});
  state.apply({id:1,type:"message.started",data:{messageId:"m",startedAt:100}});
  state.apply({id:2,type:"message.finished",data:{messageId:"m",status:"failed",finishedAt:200,result:{error:"TASK_TIMEOUT"}}});
  assert.equal(state.latest?.startedAt,100);
  assert.equal(state.latest?.finishedAt,200);
  assert.match(state.latest!.result!,/TASK_TIMEOUT/);
});
