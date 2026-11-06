import type { ExpertDefinition } from "../../../../../src/shared/experts.js";
import type { Preparation } from "../skills/types.js";
export type { ExpertDefinition };
export interface ExpertCard {
  id: string;
  name: string;
  description: string;
  source: "private" | "builtin";
  status: "active" | "deleted";
  currentVersionId: string;
  profession?:string;
  categoryId?:string;
  tags?:string[];
  avatar?:string;
  expertType?:"agent"|"team";
}
export interface ExpertVersion {
  id: string;
  versionNumber: number;
  definition: ExpertDefinition;
}
export interface ExpertDetail extends ExpertCard {
  versions: ExpertVersion[];
}
export interface SkillChoice {
  id: string;
  skillId: string;
  name: string;
  source: string;
  version: number;
}
export interface Installation {
  id: string;
  state: "installing" | "ready" | "failed" | "cancelling" | "cancelled";
  status: "active" | "cancelling" | "cancelled";
  items: (Preparation & { versionId: string; name?:string })[];
}
export const emptyExpert: ExpertDefinition = {
  name: "",
  description: "",
  role: "",
  workflow: "",
  output: "",
  examples: [],
  skillVersionIds: [],
};
