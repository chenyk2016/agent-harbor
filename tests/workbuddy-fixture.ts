/** 自有格式夹具；不复制第三方专家正文。 */
export function workBuddyFiles() {
  const manifest = {
    name: "package-review",
    version: "1.0.0",
    description: "Review package",
    expertType: "agent",
    agentName: "reviewer",
    agents: ["./agents/helper.md", "./agents/reviewer.md"],
    displayName: { zh: "原生包验收专家" },
    displayDescription: { zh: "完整Markdown及内置技能" },
    avatar: "avatars/missing.png",
    quickPrompts: [{ zh: "请评审这份资料" }],
    unknownExtension: { preserved: true },
  };
  return [
    {
      path: "bundle/.codebuddy-plugin/plugin.json",
      content: Buffer.from(JSON.stringify(manifest)),
    },
    {
      path: "bundle/agents/reviewer.md",
      content: Buffer.from(
        "---\nname: reviewer\ndescription: Original expert\nmaxTurns: 8\nskills: [reference]\ntools: [Read, Write]\n---\n# ORIGINAL_WORKBUDDY_ROLE\nKeep this exact body.\n",
      ),
    },
    {
      path: "bundle/agents/helper.md",
      content: Buffer.from(
        "---\nname: helper\ndescription: Helper\n---\nHELPER_ROLE\n",
      ),
    },
    {
      path: "bundle/skills/reference/SKILL.md",
      content: Buffer.from(
        "---\ntitle: Reference\nsummary: WorkBuddy reference\nread_when: [review]\n---\nPRELOADED_WORKBUDDY_REFERENCE\n",
      ),
    },
    {
      path: "bundle/skills/reference/references/data.txt",
      content: Buffer.from("relative resource"),
    },
    { path: "bundle/avatars/other.png", content: Buffer.from([0, 1, 2, 255]) },
    { path: "__MACOSX/bundle/._metadata", content: Buffer.from([0, 200]) },
  ];
}
