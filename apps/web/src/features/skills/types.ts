export interface Version {
  id: string;
  versionNumber: number;
  manifest: { description: string };
  createdAt: number;
}
export interface Skill {
  id: string;
  displayName: string;
  slug: string;
  source: "private" | "builtin";
  description?: string;
  versionNumber?: number;
  installation?: { state: string; error?: string };
  currentVersionId?: string;
  setting?: {
    enabled: number;
    activeVersionId?: string;
    desiredVersionId?: string;
    pendingRequestId?: string;
    revision: number;
  };
}
export interface Detail extends Skill {
  versions: Version[];
}
export interface FileItem {
  path: string;
  text?: string;
  size: number;
}
export interface Preparation {
  request: { id: string; state: string };
  build: { state: string; error?: string; attempt: number };
  log: string;
}
export interface ImportPreview {
  id: string;
  report: {
    ok: boolean;
    manifest?: { name: string; files: string[] };
    errors: { message: string }[];
    warnings: { message: string }[];
  };
}
