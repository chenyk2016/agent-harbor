"""Publish the navigation and explicitly selected files from the repository."""

from pathlib import Path

from mkdocs.structure.files import File, Files

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_FILES = {
    "security.md": "SECURITY.md",
    "contributing.md": "CONTRIBUTING.md",
    "license.md": "LICENSE",
    "downloads/NOTICE.txt": "NOTICE",
    "downloads/app-edge.example.json": "infra/app-edge.example.json",
    "downloads/app-observation.Caddyfile.txt": "infra/app-observation.Caddyfile",
    "seccomp.md": "infra/seccomp.md",
}


def nav_paths(entries):
    for entry in entries:
        for value in entry.values():
            if isinstance(value, str):
                yield value
            else:
                yield from nav_paths(value)


def on_files(files, config):
    allowed = set(nav_paths(config.nav)) | {"assets/docs.css", "assets/docs.js"}
    public = Files([
        file for file in files
        if file.src_dir in config.theme.dirs or file.src_uri in allowed
    ])
    public.append(File.generated(
        config, "search/worker.js",
        abs_src_path=str(ROOT / "docs/assets/search-worker.js"),
    ))
    for destination, source in REPOSITORY_FILES.items():
        if source == "LICENSE":
            license_text = (ROOT / source).read_text(encoding="utf-8")
            content = "# 许可证\n\n见 [第三方声明](downloads/NOTICE.txt)。\n\n```text\n"
            content += license_text + "\n```\n"
            public.append(File.generated(config, destination, content=content))
        else:
            public.append(
                File.generated(config, destination, abs_src_path=str(ROOT / source))
            )
    return public


def on_page_markdown(markdown, page, config, files):
    # Root-level Markdown links remain valid when read directly on GitHub.
    if page.file.src_uri == "security.md":
        return markdown.replace("(infra/seccomp.md)", "(seccomp.md)")
    if page.file.src_uri == "contributing.md":
        return markdown.replace("(docs/testing.md)", "(testing.md)")
    for destination, source in REPOSITORY_FILES.items():
        markdown = markdown.replace(f"(../{source})", f"({destination})")
    return markdown
