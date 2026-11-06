"""文件边界。只操作固定工作区的目录描述符，不承担HTTP、身份或会话状态。"""
import codecs
import errno
import hashlib
import json
import os
import re
import stat
import sys
from contextlib import ExitStack


class FileError(Exception):
    pass


def parts(path):
    if not isinstance(path, str) or path.startswith("/") or "\\" in path or "\0" in path:
        raise FileError("INVALID_PATH")
    result = path.split("/") if path else []
    if any(p in ("", ".", "..") for p in result):
        raise FileError("INVALID_PATH")
    return result


def filename(name):
    if (not isinstance(name, str) or not name or name in (".", "..")
            or any(c in name for c in "/\\") or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or len(name.encode("utf-8")) > 180):
        raise FileError("INVALID_FILENAME")
    return name


def capabilities():
    return (all(f in os.supports_dir_fd for f in (os.open, os.stat, os.rename))
            and os.scandir in os.supports_fd
            and all(hasattr(os, flag) for flag in ("O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK")))


class Workspace:
    def __init__(self, root, stack):
        self.stack = stack
        self.root = self.keep(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))

    def keep(self, fd):
        self.stack.callback(os.close, fd)
        return fd

    def directory(self, path):
        fd = self.root
        # 每次打开都以已固定的父目录为基准；父目录被换成软链接也不会改变这个fd。
        for component in parts(path):
            fd = self.keep(os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd))
        return fd

    def file(self, path):
        components = parts(path)
        if not components:
            raise FileError("INVALID_PATH")
        parent = self.directory("/".join(components[:-1]))
        before = os.stat(components[-1], dir_fd=parent, follow_symlinks=False)
        self.check_file(before)
        fd = self.keep(os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent))
        after = os.fstat(fd)
        self.check_file(after)
        if version(before) != version(after):
            raise FileError("FILE_CHANGED")
        return fd, after

    @staticmethod
    def check_file(info):
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise FileError("FILE_NOT_ACCESSIBLE")

    def size(self):
        # 遍历只读目录fd，不跟随软链接；限制深度/数量，失败时不能把部分统计当额度。
        visited = set()
        count = 0

        def walk(fd, depth):
            nonlocal count
            if depth > 64:
                raise FileError("FILE_SCAN_LIMIT")
            info = os.fstat(fd)
            identity = (info.st_dev, info.st_ino)
            if identity in visited:
                return 0
            visited.add(identity)
            total = 0
            with os.scandir(fd) as entries:
                for entry in entries:
                    count += 1
                    if count > 100000:
                        raise FileError("FILE_SCAN_LIMIT")
                    try:
                        info = entry.stat(follow_symlinks=False)
                        if stat.S_ISDIR(info.st_mode):
                            child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                            try:
                                total += walk(child, depth + 1)
                            finally:
                                os.close(child)
                        elif stat.S_ISREG(info.st_mode):
                            total += info.st_size
                    except FileNotFoundError:
                        # 同时生成/删除时只承诺一次软额度观察，不承诺事务快照。
                        continue
            return total

        return {"bytes": walk(self.root, 0)}

    def listing(self, path):
        items = []
        truncated = False
        with os.scandir(self.directory(path)) as entries:
            for entry in entries:
                if len(items) == 1000:
                    truncated = True
                    break
                try:
                    info = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue  # Agent刚移走的文件不必让整个目录失败。
                kind = "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 else "blocked"
                # 非UTF-8文件名可以存在于Unix磁盘，但网页无法可靠编码为路径。
                if any(0xD800 <= ord(c) <= 0xDFFF for c in entry.name):
                    continue
                items.append({"name": entry.name, "path": f"{path}/{entry.name}" if path else entry.name,
                              "kind": kind, "size": info.st_size, "mtime": info.st_mtime_ns // 1_000_000})
        return {"path": path, "entries": sorted(items, key=lambda x: (x["kind"] != "directory", x["name"])), "truncated": truncated}

    def read(self, path, limit, output=None):
        fd, before = self.file(path)
        if output and before.st_size > limit:
            raise FileError("FILE_TOO_LARGE")
        content = bytearray()
        digest = hashlib.sha256()
        total = 0
        target = open(output, "xb") if output else None
        try:
            while total <= limit:
                chunk = os.read(fd, min(65536, limit + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    if output:
                        raise FileError("FILE_CHANGED")
                    content.extend(chunk[:len(chunk) - (total - limit)])
                    break
                digest.update(chunk)
                if target:
                    target.write(chunk)
                else:
                    content.extend(chunk)
        finally:
            if target:
                target.close()
        # 返回/发HTTP响应之前确认同一文件未被改写；这不是运行中文件的事务快照。
        if version(before) != version(os.fstat(fd)):
            raise FileError("FILE_CHANGED")
        result = {"path": path, "size": before.st_size, "mtime": before.st_mtime_ns // 1_000_000,
                  "sha256": digest.hexdigest(), "truncated": before.st_size > limit}
        if not output:
            try:
                if b"\0" in content:
                    raise ValueError("binary")
                result["text"] = codecs.getincrementaldecoder("utf-8")().decode(content, final=not result["truncated"])
            except (UnicodeDecodeError, ValueError):
                raise FileError("PREVIEW_UNSUPPORTED")
        return result

    def uploaded(self, upload_id, name):
        # 上传状态只读当前文件，不假装拥有一份不可变原件或数据库审计记录。
        path = f"uploads/{upload_id}/{name}"
        fd, before = self.file(path)
        if before.st_size > 20 * 1024 * 1024:
            raise FileError("UPLOAD_CONFLICT")
        digest = hashlib.sha256()
        size = 0
        while chunk := os.read(fd, 65536):
            size += len(chunk)
            if size > 20 * 1024 * 1024:
                raise FileError("FILE_CHANGED")
            digest.update(chunk)
        if version(before) != version(os.fstat(fd)):
            raise FileError("FILE_CHANGED")
        return {"path": path, "name": name, "size": size, "sha256": digest.hexdigest()}

    def publish(self, args):
        name, upload_id = filename(args["name"]), args["uploadId"]
        try:
            os.mkdir("uploads", mode=0o755, dir_fd=self.root)
        except FileExistsError:
            pass
        uploads = self.directory("uploads")
        try:
            os.stat(upload_id, dir_fd=uploads, follow_symlinks=False)
        except FileNotFoundError:
            # 暂存目录不在容器挂载中，只有完整文件才会通过一次rename变得可见。
            os.rename(args["stage"], upload_id, dst_dir_fd=uploads)
            result = self.uploaded(upload_id, name)
            result["duplicate"] = False
            return result
        try:
            existing = self.uploaded(upload_id, name)
        except (FileError, OSError):
            raise FileError("UPLOAD_CONFLICT")
        if existing["sha256"] != args["sha256"] or existing["size"] != args["size"]:
            raise FileError("UPLOAD_CONFLICT")
        return {**existing, "duplicate": True}


def version(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def main():
    root, operation, raw = sys.argv[1:]
    args = json.loads(raw)
    if operation == "capabilities":
        return {"available": capabilities()}
    if not capabilities():
        raise FileError("FILE_ACCESS_UNAVAILABLE")
    if operation in ("upload", "uploaded"):
        if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", args["uploadId"]):
            raise FileError("INVALID_UPLOAD_ID")
        filename(args["name"])
    with ExitStack() as stack:
        workspace = Workspace(root, stack)
        if operation == "size":
            return workspace.size()
        if operation == "list":
            return workspace.listing(args["path"])
        if operation == "preview":
            return workspace.read(args["path"], 256 * 1024)
        if operation == "download":
            return workspace.read(args["path"], 100 * 1024 * 1024, args["output"])
        if operation == "uploaded":
            return workspace.uploaded(args["uploadId"], args["name"])
        if operation == "upload":
            return workspace.publish(args)
        raise FileError("INVALID_OPERATION")


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except FileError as error:
        print(json.dumps({"error": str(error)}))
    except OSError as error:
        code = "FILE_NOT_FOUND" if error.errno == errno.ENOENT else "FILE_NOT_ACCESSIBLE" if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM) else "FILE_IO_FAILED"
        print(json.dumps({"error": code}))
