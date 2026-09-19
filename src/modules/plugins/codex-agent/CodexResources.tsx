import { useEffect, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Settings01Icon,
  PlusSignIcon,
  PencilEdit01Icon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  deleteResource,
  listResources,
  saveResource,
  probeResource,
  RESOURCE_NOTE,
  type ResourceCatalog,
} from "./resources";
import type { CodexClient, Snapshot } from "./client";

/** 资源选择始终显示，禁用状态说明具体原因，设置仍可管理未生效档案。 */
export function CodexResources({
  client,
  state,
  children,
}: {
  client: CodexClient;
  state: Snapshot;
  children?: ReactNode;
}) {
  const [catalog, setCatalog] = useState<ResourceCatalog | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{
    id: string;
    alias: string;
    baseUrl: string;
    key: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState("");
  const [editedCurrent, setEditedCurrent] = useState(false);
  const [error, setError] = useState("");
  const [remove, setRemove] = useState<string | null>(null);
  const reason = client.switchReason();
  /** 每次打开设置刷新档案，不向前端读取密钥。
   */
  const refresh = () => {
    void listResources()
      .then((value) => {
        setCatalog(value);
        setError("");
      })
      .catch((failure) => setError(String(failure)));
  };
  useEffect(() => {
    void listResources()
      .then(setCatalog)
      .catch((failure) => setError(String(failure)));
  }, [state.resourceId, open]);
  /** 保存后清空明文输入，当前资源的修改通过显式重新应用生效。 */
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      setCatalog(await saveResource(editing));
      if (editing.id === state.resourceId) setEditedCurrent(true);
      setEditing(null);
      toast.success("资源已保存，选择资源或重新应用后生效");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  };
  /** 切换失败保持当前显示并呈现原生核验结果。 */
  const select = (id: string) => {
    void client
      .switchResource(id)
      .then(() => setEditedCurrent(false))
      .catch((failure) => toast.error(String(failure)));
  };
  return (
    <>
      <span title={reason || "切换登录资源"} className="flex min-w-0 max-w-36">
        <Select
          value={state.resourceId}
          disabled={Boolean(reason) || !catalog}
          onValueChange={select}
        >
          <SelectTrigger
            size="sm"
            className="h-7 min-w-0 max-w-36 bg-transparent text-xs"
            aria-label="登录资源"
          >
            <SelectValue placeholder="登录资源" />
          </SelectTrigger>
          <SelectContent className="rounded-xl">
            {catalog?.resources.map((resource) => (
              <SelectItem key={resource.id} value={resource.id}>
                {resource.alias}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
      {children}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Codex 设置"
        title="Codex 设置"
        onClick={() => setOpen(true)}
      >
        <HugeiconsIcon icon={Settings01Icon} size={15} />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setEditing(null);
            setRemove(null);
          }
        }}
      >
        <DialogContent
          className="w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl"
          aria-describedby="codex-resources-note"
        >
          <DialogTitle>Codex 设置</DialogTitle>
          <Tabs defaultValue="resources">
            <TabsList variant="line">
              <TabsTrigger value="resources">服务商存储</TabsTrigger>
            </TabsList>
            <TabsContent value="resources" className="min-w-0 space-y-3">
              <DialogDescription id="codex-resources-note" className="sr-only">
                资源管理与切换说明
              </DialogDescription>
              <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-1">
                <li>
                  特点：支持类似 cc-switch 的资源切换，无需重启
                  Codev、无需代理。
                  <details className="inline ml-1">
                    <summary className="inline cursor-pointer text-[11px] text-foreground">
                      【更多】
                    </summary>
                    <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[10px] leading-relaxed">
                      <li>
                        {RESOURCE_NOTE} provider 名称沿用 ~/.codex/config.toml
                        的配置。
                      </li>
                      <li>
                        多渠道 API 保存在
                        ~/.codex/codev.json；别名与地址明文保存，key 使用
                        Windows
                        用户加密保护。传输是否加密取决于所配置地址是否使用
                        HTTPS。
                      </li>
                      <li>
                        受线程写锁限制，切换前须确认本插件所有任务结束，再退出旧
                        runtime、建立新 runtime。provider
                        保持不变，原线程可在下次输入时恢复。
                      </li>
                      <li>
                        账号登录请先选择“原生资源”，在终端按 Codex
                        官方登录流程操作后应用资源。其他客户端持有的同一线程不能同时写入；跨
                        provider 或目录的历史迁移需另行处理，不保证自动同步。
                      </li>
                    </ul>
                  </details>
                </li>
              </ul>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span>
                  Provider：
                  <strong className="font-normal">
                    {catalog?.provider ?? "读取中"}
                  </strong>
                  （来自原生配置）
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    setEditing({
                      id: crypto.randomUUID(),
                      alias: "",
                      baseUrl: "",
                      key: "",
                    });
                    setError("");
                  }}
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={12} />
                  添加资源
                </Button>
              </div>
              {error && (
                <p role="alert" className="text-xs text-destructive break-all">
                  {error}
                  <Button size="xs" variant="ghost" onClick={refresh}>
                    重试读取
                  </Button>
                </p>
              )}
              <div className="reader-scrollbar max-h-64 overflow-auto rounded-lg border border-border">
                {catalog?.resources.map((resource) => (
                  <div
                    key={resource.id}
                    className="flex min-w-0 items-center gap-2 border-b border-border p-3 last:border-0"
                  >
                    <div className="min-w-0 flex-1 select-text">
                      <div className="truncate text-xs">
                        {resource.alias}
                        {state.resourceId === resource.id && (
                          <span className="ml-2 text-[10px] text-muted-foreground">
                            当前资源
                          </span>
                        )}
                      </div>
                      <div
                        className="truncate text-[11px] text-muted-foreground"
                        title={resource.baseUrl}
                      >
                        {resource.baseUrl || "Codex 默认地址"}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {resource.keyMask}
                      </div>
                    </div>
                    {resource.id !== "native" && (
                      <>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={probing !== null}
                          title="仅探测模型目录，不执行生成调用"
                          onClick={() => {
                            setProbing(resource.id);
                            setProbeResult("");
                            void probeResource(resource.id)
                              .then(setProbeResult)
                              .catch((failure) =>
                                setProbeResult(String(failure)),
                              )
                              .finally(() => setProbing(null));
                          }}
                        >
                          {probing === resource.id ? "探测中…" : "探测"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title={`编辑 ${resource.alias}`}
                          aria-label={`编辑 ${resource.alias}`}
                          onClick={() => {
                            setEditing({ ...resource, key: "" });
                            setError("");
                          }}
                        >
                          <HugeiconsIcon icon={PencilEdit01Icon} size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title={`删除 ${resource.alias}`}
                          aria-label={`删除 ${resource.alias}`}
                          disabled={state.resourceId === resource.id || saving}
                          onClick={() => setRemove(resource.id)}
                        >
                          <HugeiconsIcon icon={Delete02Icon} size={13} />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {remove && (
                <div className="flex items-center gap-2 text-xs">
                  <span>确认删除此资源档案？</span>
                  <Button
                    size="xs"
                    variant="destructive"
                    disabled={saving}
                    onClick={() => {
                      setSaving(true);
                      void deleteResource(remove)
                        .then((value) => {
                          setCatalog(value);
                          setRemove(null);
                        })
                        .catch((failure) => setError(String(failure)))
                        .finally(() => setSaving(false));
                    }}
                  >
                    删除
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setRemove(null)}
                  >
                    取消
                  </Button>
                </div>
              )}
              {editing && (
                <form
                  className="space-y-2 rounded-lg border border-border p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <Input
                    aria-label="资源别名"
                    placeholder="资源别名"
                    value={editing.alias}
                    onChange={(event) =>
                      setEditing({ ...editing, alias: event.target.value })
                    }
                  />
                  <Input
                    aria-label="资源 baseURL"
                    placeholder="https://example.com/v1"
                    value={editing.baseUrl}
                    onChange={(event) =>
                      setEditing({ ...editing, baseUrl: event.target.value })
                    }
                  />
                  <Input
                    aria-label="资源 API key"
                    type="password"
                    autoComplete="new-password"
                    placeholder="API key（编辑时留空保留原密钥）"
                    value={editing.key}
                    onChange={(event) =>
                      setEditing({ ...editing, key: event.target.value })
                    }
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setEditing(null)}
                    >
                      取消编辑
                    </Button>
                    <Button
                      size="xs"
                      type="submit"
                      disabled={
                        saving ||
                        !editing.alias.trim() ||
                        !editing.baseUrl.trim()
                      }
                    >
                      保存资源
                    </Button>
                  </div>
                </form>
              )}
              <div className="flex items-center justify-between gap-2">
                <p
                  className="min-w-0 truncate text-[10px] text-muted-foreground"
                  title={catalog?.path}
                >
                  {catalog?.path}
                </p>
                <span title={reason}>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={Boolean(reason)}
                    onClick={() => select(state.resourceId)}
                  >
                    应用当前资源
                  </Button>
                </span>
              </div>
              {editedCurrent && (
                <p role="status" className="text-xs text-muted-foreground">
                  当前档案已修改，重新应用后生效。
                </p>
              )}
              {probeResult && (
                <p role="status" className="text-xs text-muted-foreground">
                  {probeResult}
                </p>
              )}
              {reason && (
                <p role="status" className="text-xs text-muted-foreground">
                  {reason}
                </p>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  );
}
