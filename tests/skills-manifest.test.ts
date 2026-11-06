/** 只验证文件保存和元数据格式；技能正文与原生字段不做平台审核。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSkillPackage,
  normalizePath,
  packageDigest,
  type PackageFile,
} from "../src/service/skills/manifest.js";

const skill = (
  body = "Run the script.\n",
  frontmatter = "name: table-summary\ndescription: Summarize a CSV file.\n",
) => `---\n${frontmatter}---\n\n${body}`;

const pkg = (extra: PackageFile[] = [], text = skill()): PackageFile[] => [
  { path: "SKILL.md", size: text.length, text },
  ...extra,
];

test("accepts a root SKILL.md and reports the manifest", () => {
  const report = validateSkillPackage(
    pkg([{ path: "scripts/summarize.py", size: 120, text: "print('x')\n" }]),
  );
  assert.equal(report.ok, true);
  assert.equal(report.manifest?.name, "table-summary");
  assert.equal(report.manifest?.userInvocable, true);
  assert.deepEqual(report.manifest?.files, [
    "SKILL.md",
    "scripts/summarize.py",
  ]);
  assert.match(report.digest ?? "", /^[a-f0-9]{64}$/);
});

test("accepts one nested skill directory and strips its prefix", () => {
  const text = skill();
  const report = validateSkillPackage([
    { path: "table-summary/SKILL.md", size: text.length, text },
  ]);
  assert.equal(report.ok, true);
  assert.equal(report.manifest?.name, "table-summary");
});

test("rejects a package without SKILL.md or with two of them", () => {
  assert.equal(
    validateSkillPackage([{ path: "README.md", size: 3, text: "hi" }]).ok,
    false,
  );
  const two = [
    { path: "SKILL.md", size: 10, text: skill() },
    { path: "other/SKILL.md", size: 10, text: skill() },
  ];
  assert.equal(validateSkillPackage(two).ok, false);
});

test("rejects invalid names, missing descriptions and unsafe paths", () => {
  const cases: PackageFile[][] = [
    pkg([], skill("body", "name: Table Summary\ndescription: x\n")),
    pkg([], skill("body", "name: table\ndescription: \n")),
    pkg([{ path: "../escape.txt", size: 1, text: "x" }]),
    pkg([{ path: "/etc/passwd", size: 1, text: "x" }]),
    pkg([{ path: "a\\b.txt", size: 1, text: "x" }]),
  ];
  for (const files of cases)
    assert.equal(validateSkillPackage(files).ok, false);
});

test("rejects symlinks and case-duplicated paths, but preserves bundled dependencies", () => {
  assert.equal(
    validateSkillPackage(pkg([{ path: "link", size: 1, kind: "symlink" }])).ok,
    false,
  );
  assert.equal(
    validateSkillPackage(
      pkg([{ path: "node_modules/x.js", size: 1, text: "x" }]),
    ).ok,
    true,
  );
  assert.equal(
    validateSkillPackage(
      pkg([
        { path: "Scripts/A.py", size: 1, text: "x" },
        { path: "scripts/a.py", size: 1, text: "x" },
      ]),
    ).ok,
    false,
  );
});

test("preserves skill resource files without interpreting them as platform plugin configuration", () => {
  for (const path of [
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "hooks/pre.sh",
    "agents/a.md",
    "commands/c.md",
  ]) {
    assert.equal(
      validateSkillPackage(pkg([{ path, size: 1, text: "{}" }])).ok,
      true,
      path,
    );
  }
});

test("leaves dynamic preprocessing and native frontmatter extensions to Claude", () => {
  const report = validateSkillPackage(
    pkg(
      [],
      skill(
        "Loaded: !`date`\n",
        "name: table-summary\ndescription: x\ncontext: fork\nagent: Explore\nhooks: {}\nfuture-native-field: true\n",
      ),
    ),
  );
  assert.equal(report.ok, true);
  assert.match(report.manifest!.body, /!`date`/);
});

test("enforces file and package size limits", () => {
  const big = validateSkillPackage(
    pkg([{ path: "big.bin", size: 21 * 1024 * 1024 }]),
  );
  assert.equal(big.ok, false);
  const many = validateSkillPackage(
    pkg(
      Array.from({ length: 1001 }, (_, index) => ({
        path: `f${index}.txt`,
        size: 1,
        text: "x",
      })),
    ),
  );
  assert.equal(many.ok, false);
});

test("parses harbor-skill.json and rejects malformed dependencies", () => {
  const good = validateSkillPackage(
    pkg([
      { path: "requirements.lock", size: 1, text: "x" },
      {
        path: "harbor-skill.json",
        size: 40,
        text: '{"schemaVersion":1,"dependencies":{"python":{"lockFile":"requirements.lock","binaryOnly":true}}}',
      },
    ]),
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.manifest?.harbor?.dependencies?.python, {
    lockFile: "requirements.lock",
    binaryOnly: true,
  });

  const bad = validateSkillPackage(
    pkg([
      {
        path: "harbor-skill.json",
        size: 30,
        text: '{"schemaVersion":1,"dependencies":{"python":"openpyxl"}}',
      },
    ]),
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.code === "HARBOR_JSON_INVALID"));
});

test("keeps scripts without requiring platform dependency declarations", () => {
  const report = validateSkillPackage(
    pkg([{ path: "scripts/run.py", size: 10, text: "print(1)" }]),
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.warnings, []);
});

test("digest is stable across ordering and changes with content", () => {
  const a = pkg([
    { path: "b.txt", size: 1, text: "b" },
    { path: "a.txt", size: 1, text: "a" },
  ]);
  const b = [...a].reverse();
  assert.equal(packageDigest(a), packageDigest(b));
  const changed = pkg([
    { path: "b.txt", size: 1, text: "B" },
    { path: "a.txt", size: 1, text: "a" },
  ]);
  assert.notEqual(packageDigest(a), packageDigest(changed));
});

test("normalizes redundant prefixes but rejects traversal", () => {
  assert.equal(normalizePath("./a//b.txt"), "a/b.txt");
  assert.equal(normalizePath("../a"), null);
  assert.equal(normalizePath("a/../../b"), null);
  assert.equal(normalizePath(""), null);
});
