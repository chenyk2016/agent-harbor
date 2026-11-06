/** 卡片目录只负责浏览和启停；文件编辑留在独立详情页，保存后才生成版本。 */
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Flex,
  HStack,
  Input,
  SimpleGrid,
  Spinner,
  Text,
  Switch,
} from "@chakra-ui/react";
import { Layers, Pencil, Plus, Upload } from "lucide-react";
import { NewSkillDialog, ImportSkillDialog } from "./SkillDialogs.js";
import { SkillEditor } from "./SkillEditor.js";
import type { Skill, Detail, ImportPreview } from "./types.js";
import { Link, useNavigate, useParams } from "react-router";
import { useWorkbench } from "../../app/workbench-context.js";
import { PageHeader } from "../shell/PageHeader.js";
import { skillError } from "./errors.js";

export function SkillsPage() {
  const { api, created, problem } = useWorkbench();
  const navigate = useNavigate();
  const { skillId: selected } = useParams();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false),
    [preview, setPreview] = useState<ImportPreview>();
  const upload = useRef<HTMLInputElement>(null),
    alive = useRef(true),
    generation = useRef(0);
  const report = (error: unknown) => {
    if (alive.current) {
      problem(error);
      setError(skillError(error));
    }
  };
  const refresh = async () => {
    const current = ++generation.current;
    const rows = await api.request<Skill[]>("/skills");
    if (alive.current && current === generation.current) setSkills(rows);
  };
  useEffect(() => {
    alive.current = true;
    void refresh().catch(report);
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [api]);
  const installing = skills.some(
    (skill) => skill.installation?.state === "waiting",
  );
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh().catch(report);
    }, 2000);
    return () => clearInterval(timer);
  }, [installing, api]);
  const action = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (error) {
      report(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const toggle = (skill: Skill, enabled: boolean) =>
    action(async () => {
      await api.request(`/me/skills/${skill.id}`, "PATCH", {
        enabled,
        versionId: enabled ? skill.currentVersionId : undefined,
        expectedRevision: skill.setting?.revision ?? 0,
        clientRequestId: crypto.randomUUID(),
      });
      await refresh();
    });
  if (selected)
    return (
      <SkillEditor
        key={selected}
        api={api}
        id={selected}
        close={() => navigate("/skills")}
        changed={refresh}
        created={(id) => void created(id).catch(problem)}
        problem={problem}
      />
    );
  const matching = skills.filter((skill) =>
    `${skill.displayName} ${skill.slug} ${skill.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  return (
    <Box flex={1} minH={0} overflowY="auto">
      <Box
        maxW="1120px"
        mx="auto"
        px={{ base: 4, md: 8 }}
        py={{ base: 5, md: 7 }}
      >
        <PageHeader
          title="技能"
          subtitle="保存一套可复用的方法。启用后，新会话里的 Agent 会自动发现并调用。"
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Upload size={14} />}
                isDisabled={busy}
                onClick={() => upload.current?.click()}
              >
                导入
              </Button>
              <Button
                size="sm"
                leftIcon={<Plus size={14} />}
                isDisabled={busy}
                onClick={() => {
                  setError("");
                  setCreateOpen(true);
                }}
              >
                新建技能
              </Button>
            </>
          }
        />

        <Flex gap={2.5} mb={5} align="center" flexWrap="wrap">
          <Input
            bg="surface"
            w={{ base: "full", sm: "260px" }}
            h="34px"
            fontSize="13px"
            aria-label="搜索技能"
            placeholder="搜索技能"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Text fontSize="11.5px" color="muted">
            共 {matching.length} 个
          </Text>
          <Box flex={1} />
          <Text fontSize="11.5px" color="muted">
            保存即生成新版本
          </Text>
        </Flex>

        {error && (
          <Alert status="error" borderRadius="9px" mb={4} fontSize="12px">
            <AlertIcon boxSize="14px" />
            {error}
          </Alert>
        )}

        {(
          [
            ["private", "我的技能"],
            ["builtin", "平台内置"],
          ] as const
        ).map(([source, label]) => {
          const group = matching.filter((skill) => skill.source === source);
          return (
            <Box key={source} mb={7}>
              <HStack spacing={2} mb={3}>
                <Text fontSize="13.5px" fontWeight={650}>
                  {label}
                </Text>
                <Text fontSize="11.5px" color="muted">
                  {group.length}
                </Text>
              </HStack>
              <SimpleGrid
                columns={{ base: 1, sm: 2, lg: 3 }}
                spacing={2.5}
              >
                {group.map((skill) => {
                  const pending = skill.installation?.state === "waiting",
                    failed = skill.installation?.state === "failed";
                  const update =
                    !!skill.setting?.enabled &&
                    skill.setting.activeVersionId !== skill.currentVersionId;
                  const enabled = !!skill.setting?.enabled;
                  return (
                    <Box
                      key={skill.id}
                      border="1px solid"
                      borderColor="line"
                      borderRadius="14px"
                      bg="surface"
                      p={4}
                      transition="border-color .15s, box-shadow .15s"
                      _hover={{ borderColor: "lineStrong", boxShadow: "sm" }}
                    >
                      <Flex
                        as={Link}
                        to={`/skills/${skill.id}`}
                        gap={2.5}
                        align="flex-start"
                        _hover={{ textDecoration: "none" }}
                        onClick={() => setError("")}
                      >
                        <Flex
                          w="32px"
                          h="32px"
                          borderRadius="9px"
                          bg={source === "private" ? "brand.50" : "sunken"}
                          color={source === "private" ? "brand.600" : "ink2"}
                          align="center"
                          justify="center"
                          flexShrink={0}
                        >
                          <Layers size={17} />
                        </Flex>
                        <Box minW={0} flex={1}>
                          <Text
                            fontSize="13.5px"
                            fontWeight={600}
                            lineHeight={1.4}
                            noOfLines={1}
                          >
                            {skill.displayName}
                          </Text>
                          <Text fontSize="10.5px" color="muted" mt="2px">
                            {source === "private" ? "用户自定义" : "平台内置"} · v
                            {skill.versionNumber ?? "—"}
                          </Text>
                        </Box>
                        <Box color="muted" mt="4px" flexShrink={0}>
                          <Pencil size={14} />
                        </Box>
                      </Flex>
                      <Text
                        fontSize="12px"
                        color="ink2"
                        lineHeight={1.65}
                        mt={2.5}
                        minH="40px"
                        noOfLines={2}
                      >
                        {skill.description || skill.slug}
                      </Text>
                      <Flex
                        align="center"
                        gap={2}
                        mt={3}
                        pt={2.5}
                        borderTop="1px solid"
                        borderColor="line"
                      >
                        {pending ? (
                          <Spinner size="xs" color="brand.500" />
                        ) : (
                          <Switch
                            size="sm"
                            colorScheme="brand"
                            aria-label={`启用 ${skill.displayName}`}
                            isChecked={enabled}
                            isDisabled={busy}
                            onChange={(event) =>
                              void toggle(skill, event.target.checked)
                            }
                          />
                        )}
                        <Text
                          fontSize="11px"
                          color={failed ? "dangerStrong" : enabled ? "ok" : "muted"}
                        >
                          {pending
                            ? "正在安装…"
                            : failed
                              ? "安装失败"
                              : enabled
                                ? "已启用"
                                : "未启用"}
                        </Text>
                        <Box flex={1} />
                        {update && (
                          <Text fontSize="10.5px" color="warnStrong">
                            有新版本
                          </Text>
                        )}
                      </Flex>
                    </Box>
                  );
                })}
              </SimpleGrid>
              {!group.length && (
                <Text color="muted" fontSize="12.5px">
                  {search
                    ? "没有匹配的技能"
                    : source === "private"
                      ? "还没有自定义技能，可以新建或导入 ZIP。"
                      : "暂无平台内置技能"}
                </Text>
              )}
            </Box>
          );
        })}

        <input
          ref={upload}
          type="file"
          accept=".zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file)
              void action(async () => setPreview(await api.importSkill(file)));
          }}
        />
      </Box>

      <NewSkillDialog
        open={createOpen}
        busy={busy}
        error={error}
        close={() => setCreateOpen(false)}
        create={({ name, slug, description }) =>
          void action(async () => {
            const item = await api.request<Detail>("/skills", "POST", {
              clientRequestId: crypto.randomUUID(),
              displayName: name,
              skillMd: `---\nname: ${JSON.stringify(slug)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n先确认用户目标和输入资料，再执行任务。成果写入 /workspace。\n`,
            });
            if (alive.current) {
              setCreateOpen(false);
              navigate(`/skills/${item.id}`);
            }
            await refresh();
          })
        }
      />
      <ImportSkillDialog
        preview={preview}
        skills={skills}
        busy={busy}
        error={error}
        close={() => setPreview(undefined)}
        apply={(target) =>
          void action(async () => {
            const item = await api.request<Detail>(
              `/skill-imports/${preview!.id}/apply`,
              "POST",
              {
                targetSkillId: target || undefined,
                expectedVersionId: target
                  ? skills.find((skill) => skill.id === target)
                      ?.currentVersionId
                  : undefined,
              },
            );
            if (alive.current) {
              setPreview(undefined);
              navigate(`/skills/${item.id}`);
            }
            await refresh();
          })
        }
      />
    </Box>
  );
}
