/** 会话固定的能力清单。这里只放可执行事实，不接收浏览器透传SDK或Docker参数。 */
export interface CapabilitySkill {
  skillId: string;
  versionId: string;
  version: number;
  buildId: string;
  name: string;
  namespace: "personal" | "builtin";
  invocationName: string;
  sourceHash: string;
  buildHash: string;
  userInvocable: boolean;
}
export interface CapabilitySnapshot {
  schemaVersion: 1;
  digest: string;
  imageId: string;
  skills: CapabilitySkill[];
}
