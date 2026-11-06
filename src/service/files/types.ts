/** 文件接口只暴露相对路径和用户可见元数据，不返回宿主路径。 */
export interface FileEntry { name: string; path: string; kind: "directory" | "file" | "blocked"; size: number; mtime: number }
export interface FileListing { path: string; entries: FileEntry[]; truncated: boolean }
export interface FilePreview { path: string; text: string; size: number; mtime: number; truncated: boolean }
export interface UploadedFile { path: string; name: string; size: number; sha256: string; duplicate?: boolean }
export const uploadLimit = 20 * 1024 * 1024;
