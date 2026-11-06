/** 列表只展示本人及平台专家；编辑和安装由独立详情路由负责。 */
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Image,
  Input,
  SimpleGrid,
  Text,
} from "@chakra-ui/react";
import { Link, useNavigate } from "react-router";
import { Plus, Upload } from "lucide-react";
import { Select } from "../../shared/select.js";
import { useWorkbench } from "../../app/workbench-context.js";
import { PageHeader } from "../shell/PageHeader.js";
import { explain } from "../../state/workspace.js";
import type { ExpertCard, ExpertDetail } from "./types.js";

export function ExpertsPage() {
  const navigate = useNavigate(),
    fileInput = useRef<HTMLInputElement>(null),
    importId = useRef<{ file: File; id: string }>();
  const [importing, setImporting] = useState(false);
  const { api, problem } = useWorkbench();
  const [category, setCategory] = useState("");
  const [rows, setRows] = useState<ExpertCard[]>([]),
    [search, setSearch] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void api
      .request<ExpertCard[]>("/experts", "GET", undefined, abort.signal)
      .then(setRows)
      .catch((error) => {
        if (!abort.signal.aborted) {
          setError(explain(error));
          problem(error);
        }
      });
    return () => abort.abort();
  }, [api, problem]);

  const categories = [
    ...new Set(
      rows.flatMap((item) => (item.categoryId ? [item.categoryId] : [])),
    ),
  ];

  return (
    <Box flex={1} minH={0} overflowY="auto">
      <Box maxW="1120px" mx="auto" px={{ base: 4, md: 8 }} py={{ base: 5, md: 7 }}>
        <PageHeader
          title="专家"
          subtitle="固定一套工作方法和技能组合，直接在会话里复用。"
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Upload size={14} />}
                isLoading={importing}
                onClick={() => fileInput.current?.click()}
              >
                导入 WorkBuddy
              </Button>
              <Button
                as={Link}
                to="/experts/new"
                size="sm"
                leftIcon={<Plus size={14} />}
              >
                创建专家
              </Button>
            </>
          }
        />

        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          aria-label="导入WorkBuddy专家包"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (importId.current?.file !== file)
              importId.current = { file, id: crypto.randomUUID() };
            setImporting(true);
            setError("");
            void api
              .uploadExpert<ExpertDetail>(file, importId.current.id)
              .then((item) => navigate(`/experts/${item.id}`))
              .catch((error) => {
                setError(explain(error));
                problem(error);
              })
              .finally(() => setImporting(false));
          }}
        />

        <Flex gap={2.5} mb={5} align="center" flexWrap="wrap">
          <Input
            bg="surface"
            w={{ base: "full", sm: "260px" }}
            h="34px"
            fontSize="13px"
            placeholder="搜索专家"
            aria-label="搜索专家"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            ariaLabel="专家分类"
            width="160px"
            value={category || "__all__"}
            onChange={(value) => setCategory(value === "__all__" ? "" : value)}
            options={[
              { value: "__all__", label: "全部分类" },
              ...categories.map((value) => ({ value, label: value })),
            ]}
          />
          <Box flex={1} />
          <Text fontSize="11.5px" color="muted">
            共 {rows.length} 个
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
            ["private", "我的专家"],
            ["builtin", "平台内置"],
          ] as const
        ).map(([source, label]) => {
          const group = rows.filter(
            (item) =>
              item.source === source &&
              (!category || item.categoryId === category) &&
              `${item.name} ${item.profession ?? ""} ${item.description} ${item.tags?.join(" ") ?? ""}`
                .toLocaleLowerCase()
                .includes(search.toLocaleLowerCase()),
          );
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
              <SimpleGrid columns={{ base: 1, md: 2 }} spacing={2.5}>
                {group.map((item) => (
                  <Flex
                    as={Link}
                    to={`/experts/${item.id}`}
                    key={item.id}
                    direction="column"
                    gap={2.5}
                    border="1px solid"
                    borderColor="line"
                    borderRadius="14px"
                    bg="surface"
                    p={4}
                    transition="border-color .15s, box-shadow .15s"
                    _hover={{ borderColor: "lineStrong", boxShadow: "sm" }}
                    _focusVisible={{ boxShadow: "0 0 0 3px var(--ah-focus)" }}
                  >
                    <Flex align="center" gap={3}>
                      <Flex
                        w="42px"
                        h="42px"
                        flexShrink={0}
                        bg="brand.50"
                        color="brand.600"
                        borderRadius="12px"
                        align="center"
                        justify="center"
                        fontSize="17px"
                        fontWeight={600}
                        overflow="hidden"
                      >
                        {item.avatar ? (
                          <Image
                            src={item.avatar}
                            alt={item.name}
                            boxSize="42px"
                            objectFit="cover"
                          />
                        ) : (
                          item.name.slice(0, 1)
                        )}
                      </Flex>
                      <Box minW={0} flex={1}>
                        <HStack spacing={2}>
                          <Text
                            fontSize="13.5px"
                            fontWeight={600}
                            noOfLines={1}
                          >
                            {item.name}
                          </Text>
                          {item.expertType === "team" && (
                            <Badge bg="brand.50" color="brand.600">
                              专家团
                            </Badge>
                          )}
                        </HStack>
                        <Text fontSize="10.5px" color="muted" mt="2px">
                          {item.profession ?? "专家"}
                          {item.categoryId ? ` · ${item.categoryId}` : ""}
                        </Text>
                      </Box>
                    </Flex>
                    <Text
                      fontSize="12px"
                      color="ink2"
                      lineHeight={1.65}
                      noOfLines={2}
                      minH="40px"
                    >
                      {item.description}
                    </Text>
                    <Flex
                      align="center"
                      gap={1.5}
                      pt={2.5}
                      mt="auto"
                      borderTop="1px solid"
                      borderColor="line"
                      flexWrap="wrap"
                    >
                      {item.tags?.slice(0, 3).map((tag) => (
                        <Badge key={tag}>{tag}</Badge>
                      ))}
                      <Box flex={1} />
                      <Text fontSize="11px" color="brand.600">
                        查看设置
                      </Text>
                    </Flex>
                  </Flex>
                ))}
              </SimpleGrid>
              {!group.length && (
                <Text color="muted" fontSize="12.5px">
                  {source === "private"
                    ? "还没有专家，创建一个明确的工作角色吧。"
                    : "暂无平台内置专家"}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
