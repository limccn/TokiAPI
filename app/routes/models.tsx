// /models — 模型价格表（批次 P，2026-09-23）：**任何已登录用户可读**；写操作与两个行控制仅 admin。
// 单价单位：USD / 每百万 tokens（与后端 seed.sql 一致）。
//
// 角色分三层，别混：
//   ① 服务端（真防线，见 src/routes/models/procedures/list.ts）：被隐藏的行不进 member 的响应体；
//      免费模型的 5 个价在 member 的响应里**就是 0**。devtools 也读不到原价 —— 是"看不见"不是"不显示"。
//   ② 本页（怎么画）：`modelTableColumns(isAdmin)` 决定列集合、`modelBadges` 决定徽章。
//      表头与表体都从**同一份列数组**渲染（`columns.map` 两处），错位在构造上不可能。
//   ③ 后端写路由：POST/PATCH/DELETE 由 router.ts 的 adminOnly 拦（顺序敏感，见该文件头）。
//      故本页即便被改坏，member 也改不动价格表 —— 但按钮不该出现，那是 UX 不是安全。
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, Eye, EyeOff, Gift, Info, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { z } from "zod";
import { useSession } from "@/hooks/use-session";
import { useModels } from "@/modules/models/hooks/use-models";
import { useCreateModel } from "@/modules/models/hooks/use-create-model";
import { useUpdateModel } from "@/modules/models/hooks/use-update-model";
import { useDeleteModel } from "@/modules/models/hooks/use-delete-model";
import { useSyncOpenrouter } from "@/modules/models/hooks/use-sync-openrouter";
import {
  MODEL_CAP_OPTIONS,
  isUnofferedCap,
  modelBadges,
  modelTableColumns,
  snapToTier,
  type ModelTableColumnKey,
} from "@/modules/models/display";
import type { ModelResponse } from "@/modules/models/types";
import { copyToClipboard } from "@/lib/clipboard";
import { formatDateTime, formatNumber, formatUsd } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, EmptyState } from "@/components/ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ============= Zod 表单 Schema =============
// 分层规则（M9）：未缓存输入 > 128K tokens 时输入与输出均取 long 档，否则 short 档；
// 缓存命中输入按 cached 价计。单价单位：USD / 每百万 tokens。
//
// ⚠ 这两份 schema **只服务于表单弹窗**。Actions 列的两个行控制**不经过它们**：
// 它们的 refine 与后端那份（src/routes/models/types.ts）不一致 —— 后端把 freeMode /
// hiddenFromMembers 也算进"至少改一项"，走这里会被 refine 拦下（"Change at least one price"）。
// 表单也刻意不渲染这两个标记（创建路径同样不暴露，见后端 createModelInputSchema 的注释）。

const priceField = z.coerce.number("Enter a number").min(0, "Must be 0 or greater");

const createModelSchema = z.object({
  model: z.string().min(1, "Model name is required").max(200, "Max 200 characters"),
  inputPriceShort: priceField,
  inputPriceLong: priceField,
  inputPriceCached: priceField,
  outputPriceShort: priceField,
  outputPriceLong: priceField,
  // 09-01-stg-glm-ccswitch-fix：模型级输出上限（null/空 ≡ 不限制）
  maxOutputTokens: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : v),
    z.coerce.number().int("Must be a whole number").min(1, "Min 1 token").nullable(),
  ),
});

const updateModelSchema = z
  .object({
    inputPriceShort: priceField.optional(),
    inputPriceLong: priceField.optional(),
    inputPriceCached: priceField.optional(),
    outputPriceShort: priceField.optional(),
    outputPriceLong: priceField.optional(),
    // 显式 null = 重置为不限制（与后端 API 语义一致）；省略 = 不改动
    maxOutputTokens: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? null : v),
      z.coerce.number().int("Must be a whole number").min(1, "Min 1 token").nullable(),
    ),
  })
  .refine(
    (v) =>
      v.inputPriceShort !== undefined ||
      v.inputPriceLong !== undefined ||
      v.inputPriceCached !== undefined ||
      v.outputPriceShort !== undefined ||
      v.outputPriceLong !== undefined ||
      v.maxOutputTokens !== null,
    { message: "Change at least one price" },
  );

// ============= 子组件：模型名复制按钮 =============

/**
 * Model 列的名字旁边那个复制按钮（照 keys.tsx CopyBlock 的体例：Clipboard API → execCommand
 * 降级、2s 复位、卸载清 timer、aria-label 随状态切换）。
 *
 * 每个行实例**自持** copied 态（不共用一个"当前复制的是哪行"的页面态）：共用态得额外维护
 * "哪一行正在显示已复制"，而列表重渲染/重排后那个 id 会指向别的行。
 */
function CopyModelButton({ model }: { model: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimer = useRef<number | null>(null);

  // 卸载时清掉复位定时器，避免离开页面后仍触发 setState
  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const handleCopy = async () => {
    const ok = await copyToClipboard(model);
    if (!ok) {
      // 静默失败在复制场景里最坏（用户以为复制到了，粘出来是旧内容）——给可见反馈
      setFailed(true);
      setCopied(false);
      return;
    }
    setFailed(false);
    setCopied(true);
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
    }
    resetTimer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleCopy}
        /* 无可见文字 ⇒ 可访问名只能由 aria-label 提供，且随状态切换：
           屏幕阅读器重新聚焦时读到的是当前状态。也正因如此，行内复制按钮的锚点
           与 CopyBlock 不同 —— 它得带模型名才能定位到具体哪一行。
           h-6/w-6 覆盖 size="icon" 的 h-9/w-9（twMerge 同组后者胜）。 */
        aria-label={copied ? "Copied" : `Copy ${model}`}
        title={copied ? "Copied" : "Copy model name"}
        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
      {failed ? <span className="text-xs text-destructive">Copy failed</span> : null}
    </>
  );
}

// ============= 子组件：价格表单对话框 =============

interface ModelFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: ModelResponse;
}

function ModelFormDialog({ open, onOpenChange, editing }: ModelFormDialogProps) {
  const createModel = useCreateModel();
  const updateModel = useUpdateModel();

  const [model, setModel] = useState("");
  const [inputPriceShort, setInputPriceShort] = useState("");
  const [inputPriceLong, setInputPriceLong] = useState("");
  const [inputPriceCached, setInputPriceCached] = useState("");
  const [outputPriceShort, setOutputPriceShort] = useState("");
  const [outputPriceLong, setOutputPriceLong] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setModel(editing?.model ?? "");
      setInputPriceShort(editing ? String(editing.inputPriceShort) : "");
      setInputPriceLong(editing ? String(editing.inputPriceLong) : "");
      setInputPriceCached(editing ? String(editing.inputPriceCached) : "");
      setOutputPriceShort(editing ? String(editing.outputPriceShort) : "");
      setOutputPriceLong(editing ? String(editing.outputPriceLong) : "");
      setMaxOutputTokens(snapToTier(editing?.maxOutputTokens ?? null));
      setErrors({});
    }
  }

  // 批次 Q（D22）：库里「不在下拉档位上」的上限在**打开弹窗时**已被上面吸附到最近档
  // （保存即写回），这里只负责把原值如实显示出来。读 `editing`（库值）而非 state ——
  // state 已是吸附后的值。注意判据是**下拉提供集**，不是构建期网格（见 display.ts 的注释）。
  const storedCap = editing?.maxOutputTokens ?? null;
  // 判据是**问题判据**（true = 要提示）：`isUnofferedCap(null) === false`（不限不是问题）
  const unofferedCap = isUnofferedCap(storedCap) ? storedCap : null;

  const isBusy = createModel.isPending || updateModel.isPending;
  const mutationError = createModel.error?.message ?? updateModel.error?.message;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    // 空字符串 → undefined：update 视为“该项不改”，create 触发必填错误
    const prices = {
      inputPriceShort: inputPriceShort.length > 0 ? inputPriceShort : undefined,
      inputPriceLong: inputPriceLong.length > 0 ? inputPriceLong : undefined,
      inputPriceCached: inputPriceCached.length > 0 ? inputPriceCached : undefined,
      outputPriceShort: outputPriceShort.length > 0 ? outputPriceShort : undefined,
      outputPriceLong: outputPriceLong.length > 0 ? outputPriceLong : undefined,
      // 空 → null = 不限制（create 亦可）；编辑时显式 null = 清除已设上限
      maxOutputTokens: maxOutputTokens.length > 0 ? maxOutputTokens : null,
    };
    if (editing) {
      const parsed = updateModelSchema.safeParse(prices);
      if (!parsed.success) {
        setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "root"), i.message])));
        return;
      }
      try {
        await updateModel.mutateAsync({ id: editing.id, ...parsed.data });
        onOpenChange(false);
      } catch {
        // 错误显示在对话框底部
      }
    } else {
      const parsed = createModelSchema.safeParse({ model, ...prices });
      if (!parsed.success) {
        setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "root"), i.message])));
        return;
      }
      try {
        await createModel.mutateAsync(parsed.data);
        onOpenChange(false);
      } catch {
        // 错误显示在对话框底部
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit prices — ${editing.model}` : "Add model price"}
      description="Prices are in USD per 1,000,000 tokens; 0 means free. Uncached input over 128K tokens bills the long tier (input + output); cached input bills at the cached rate."
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {mutationError ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {mutationError}
          </p>
        ) : null}
        {editing ? null : (
          <div className="space-y-2">
            <Label htmlFor="model-name">Model name</Label>
            <Input
              id="model-name"
              placeholder="gpt-5.6-sol"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-invalid={errors.model !== undefined}
            />
            {errors.model ? <p className="text-xs text-destructive">{errors.model}</p> : null}
          </div>
        )}
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Input — USD per 1M tokens</span>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="model-input-short">Short ≤ 128K</Label>
              <Input
                id="model-input-short"
                type="number"
                step="any"
                min={0}
                placeholder="2.50"
                value={inputPriceShort}
                onChange={(e) => setInputPriceShort(e.target.value)}
                aria-invalid={errors.inputPriceShort !== undefined}
              />
              {errors.inputPriceShort ? (
                <p className="text-xs text-destructive">{errors.inputPriceShort}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-input-long">Long &gt; 128K</Label>
              <Input
                id="model-input-long"
                type="number"
                step="any"
                min={0}
                placeholder="4.00"
                value={inputPriceLong}
                onChange={(e) => setInputPriceLong(e.target.value)}
                aria-invalid={errors.inputPriceLong !== undefined}
              />
              {errors.inputPriceLong ? (
                <p className="text-xs text-destructive">{errors.inputPriceLong}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-input-cached">Cached hit</Label>
              <Input
                id="model-input-cached"
                type="number"
                step="any"
                min={0}
                placeholder="0.25"
                value={inputPriceCached}
                onChange={(e) => setInputPriceCached(e.target.value)}
                aria-invalid={errors.inputPriceCached !== undefined}
              />
              {errors.inputPriceCached ? (
                <p className="text-xs text-destructive">{errors.inputPriceCached}</p>
              ) : null}
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Output — USD per 1M tokens</span>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="model-output-short">Short ≤ 128K</Label>
              <Input
                id="model-output-short"
                type="number"
                step="any"
                min={0}
                placeholder="10.00"
                value={outputPriceShort}
                onChange={(e) => setOutputPriceShort(e.target.value)}
                aria-invalid={errors.outputPriceShort !== undefined}
              />
              {errors.outputPriceShort ? (
                <p className="text-xs text-destructive">{errors.outputPriceShort}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-output-long">Long &gt; 128K</Label>
              <Input
                id="model-output-long"
                type="number"
                step="any"
                min={0}
                placeholder="15.00"
                value={outputPriceLong}
                onChange={(e) => setOutputPriceLong(e.target.value)}
                aria-invalid={errors.outputPriceLong !== undefined}
              />
              {errors.outputPriceLong ? (
                <p className="text-xs text-destructive">{errors.outputPriceLong}</p>
              ) : null}
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="model-max-output">Max output (tokens)</Label>
          {/* 批次 Q：档位下拉取代自由输入 —— 库值只可能来自 MODEL_CAP_OPTIONS ⇒ 下拉给不出的值在输入侧绝迹 */}
          <Select
            id="model-max-output"
            value={maxOutputTokens}
            onChange={(e) => setMaxOutputTokens(e.target.value)}
            aria-invalid={errors.maxOutputTokens !== undefined}
          >
            {MODEL_CAP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {unofferedCap !== null ? (
            <p className="text-xs text-muted-foreground">
              Stored value {formatNumber(unofferedCap)} is not one of the offered tiers —
              preselecting{" "}
              {MODEL_CAP_OPTIONS.find((option) => option.value === maxOutputTokens)?.label}. Saving
              will update it.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Hard cap on requested <code>max_tokens</code>; the gateway clamps anything above it.
            Tiers are multiples of the 8,192 × 2 baseline, so whatever this form saves is one of the
            five options above. For models baked into the runtime constants a tier below the
            constant only binds requests above it, and Unlimited still gets the constant injected,
            until the constants are regenerated and redeployed; rows added here are not baked, so
            they take effect immediately. The grid's floor is 8,192 — a slow upstream can need less
            than that, and no tier expresses it (b.ai glm-5.3-flash: ~37 tok/s; see
            spec/backend/proxy-protocols.md).
          </p>
          {errors.maxOutputTokens ? (
            <p className="text-xs text-destructive">{errors.maxOutputTokens}</p>
          ) : null}
        </div>
        {errors.root ? <p className="text-xs text-destructive">{errors.root}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            Cancel
          </Button>
          <Button type="submit" disabled={isBusy}>
            {isBusy ? "Saving…" : editing ? "Save changes" : "Add price"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ============= 页面 =============

export default function ModelsPage() {
  const { user } = useSession();
  const isAdmin = user?.role === "admin";

  const modelsQuery = useModels();
  const deleteModel = useDeleteModel();
  // 行控制专用的 PATCH 实例 —— 与弹窗里那个**不是同一个**（mutate 的 isPending/error 各自独立，
  // 否则点一下 Free 会让弹窗按钮也转成 "Saving…"）。
  const updateModel = useUpdateModel();
  // 同步按钮专用的 mutation 实例（10-16-openrouter-price-sync）：isPending/error 自持，
  // 不与上面的行控制/弹窗实例共享。
  const syncOpenrouter = useSyncOpenrouter();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ModelResponse | null>(null);
  const [deleting, setDeleting] = useState<ModelResponse | null>(null);

  const items = modelsQuery.data?.items ?? [];
  const columns = modelTableColumns(isAdmin);
  // 哪个行正在发请求（行内禁用）：只关这一行的按钮，不把整表冻住
  const pendingRowId = updateModel.isPending ? updateModel.variables?.id : undefined;

  // 前端内存过滤（列表量小；API 无 search 参数）
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const filtered = query ? items.filter((m) => m.model.toLowerCase().includes(query)) : items;

  // 列 → 单元格渲染器。写成 `Record<ModelTableColumnKey, …>` 而非 switch：
  // display.ts 里新增一个列 key 而这里忘了补渲染器 = **类型错误**（漏项无处可逃）。
  const cellRenderers: Record<ModelTableColumnKey, (item: ModelResponse) => ReactNode> = {
    model: (item) => (
      <div className="flex items-center gap-1.5">
        <span className="font-medium">{item.model}</span>
        <CopyModelButton model={item.model} />
        {modelBadges(item, isAdmin).map((badge) => (
          <Badge key={badge.key} variant={badge.variant} title={badge.title}>
            {badge.label}
          </Badge>
        ))}
      </div>
    ),
    input: (item) => (
      <>
        {formatUsd(item.inputPriceShort)} → {formatUsd(item.inputPriceLong)}
      </>
    ),
    inputCached: (item) => <>{formatUsd(item.inputPriceCached)}</>,
    output: (item) => (
      <>
        {formatUsd(item.outputPriceShort)} → {formatUsd(item.outputPriceLong)}
      </>
    ),
    maxOutput: (item) => (
      <>{item.maxOutputTokens ? item.maxOutputTokens.toLocaleString() : "∞"}</>
    ),
    updated: (item) => <>{formatDateTime(item.updatedAt)}</>,
    actions: (item) => {
      const rowPending = pendingRowId === item.id;
      return (
        <div className="flex items-center justify-end gap-1.5">
          {/* 两个行控制（批次 P，D17/D19；2026-09-23 用户改为图标按钮）：
              🎁 Gift = 活动免费、👁 Eye/EyeOff = 对 member 可见/不可见。
              随后一条竖分隔线隔开 Edit/Delete —— 「改这个模型的计费语义」与「编辑/删除这一行」
              是两类动作，视觉上不该连成一片；四个按钮同为 size="icon"（h-9 w-9）时这一行才齐平。
              原生 disabled（与账户菜单的灰项相反）：这是独立动作按钮，不参与键盘方向键导航，
              禁用态用原生属性才拦得住点击。

              ⚠ 图标按钮**没有可见文字**，可访问名全靠 aria-label，三条约定缺一不可：
                · `aria-label` **恒定**（不随状态变）—— 它是这个按钮的身份，兼作探针/测试的定位锚；
                · `aria-pressed` = **当前状态**（同 dashboard.tsx 的 Time Filter 与批次 P 的有字按钮）；
                · `title` = **点下去会发生什么**（动态），弥补图标说不清的语义 ——
                  Eye 一族尤其容易与「预览/查看」混淆，而 Gift 不点开不知道是开还是关。
              可见图标也随状态换（Eye ⇄ EyeOff），与 aria-pressed 说的是同一件事。 */}
          <Button
            variant={item.freeMode ? "default" : "outline"}
            size="icon"
            aria-pressed={item.freeMode}
            aria-label="Free mode"
            disabled={rowPending}
            onClick={() => updateModel.mutate({ id: item.id, freeMode: !item.freeMode })}
            title={
              item.freeMode
                ? "Free mode on — click to bill at the prices in this table"
                : "Bill this model at the free-mode rate (prices in this table stay unchanged)"
            }
          >
            <Gift aria-hidden="true" />
          </Button>
          <Button
            variant={item.hiddenFromMembers ? "default" : "outline"}
            size="icon"
            aria-pressed={item.hiddenFromMembers}
            aria-label="Hide from members"
            disabled={rowPending}
            onClick={() => updateModel.mutate({ id: item.id, hiddenFromMembers: !item.hiddenFromMembers })}
            title={
              item.hiddenFromMembers
                ? "Hidden from members — click to list this row again"
                : "Hide this row from the member price table (the model is still served)"
            }
          >
            {item.hiddenFromMembers ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
          <span className="h-4 w-px bg-border" aria-hidden="true" />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setEditing(item)}
            aria-label={`Edit ${item.model}`}
            title="Edit"
          >
            <Pencil aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleting(item)}
            aria-label={`Delete ${item.model}`}
            title="Delete"
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      );
    },
  };

  return (
    <PageContainer>
      <PageHeader
        title="Model pricing"
        // 副标题两角色同一句：「— read-only」对 member 是**多余的**（页面上没有编辑入口，
        // 而服务端投影已把 admin 才有的列整列拿掉 —— 想说的事实已由「看不到按钮」表达，
        // 再写一遍只是噪声）。用户 2026-09-23 裁定删除。
        description="Price table used for usage billing"
        actions={
          // Add price / Sync prices 仅 admin：member 发 POST 会被后端 403，按钮本就不该出现
          isAdmin ? (
            <>
              {/* 同步（10-16-openrouter-price-sync）：服务端拉 OR 目录 → 刷价 + 白名单补插。
                  失败顶在表格上方（与行控制同款 alert 条），成功回显 synced/inserted 明细。 */}
              <Button
                variant="outline"
                disabled={syncOpenrouter.isPending}
                onClick={() => syncOpenrouter.mutate()}
              >
                <RefreshCw
                  className={syncOpenrouter.isPending ? "animate-spin" : undefined}
                  aria-hidden="true"
                />
                {syncOpenrouter.isPending ? "Syncing…" : "Sync prices"}
              </Button>
              <Button onClick={() => setFormOpen(true)}>
                <Plus aria-hidden="true" />
                Add price
              </Button>
            </>
          ) : undefined
        }
      />

      <Card className="mb-6">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Model pricing</CardTitle>
            {/* 副标题（批次 L，2026-09-21 用户裁决）：改显合计 `<N> total`；原先那段分层规则说明
                （短/长档、缓存价）**移到卡片最下方**的单条 information 文本 —— 见 CardContent 末尾。 */}
            <CardDescription>{formatNumber(items.length)} total</CardDescription>
          </div>
          {items.length > 0 ? (
            <div className="relative w-40 shrink-0">
              <Search
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                aria-label="Search models"
                className="pl-9"
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {/* 行控制失败（无 toast 基建）：顶在表格上方给一条可见提示，不静默吞掉 */}
          {isAdmin && updateModel.isError ? (
            <div className="p-6 pb-0">
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {updateModel.error.message}
              </p>
            </div>
          ) : null}
          {/* 同步结果条（同款告警条体例）：失败显 error；成功显 synced/inserted/skipped 明细。
              不自动消失 —— 同步是显式动作，结果该留到用户离开/下次操作。 */}
          {isAdmin && syncOpenrouter.isError ? (
            <div className="p-6 pb-0">
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {syncOpenrouter.error.message}
              </p>
            </div>
          ) : isAdmin && syncOpenrouter.data ? (
            <div className="p-6 pb-0">
              <p
                role="status"
                className="rounded-md border border-muted bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              >
                Synced {syncOpenrouter.data.synced} prices,{" "}
                {syncOpenrouter.data.inserted} new models from OpenRouter
                {syncOpenrouter.data.skipped.length > 0
                  ? ` (${syncOpenrouter.data.skipped.length} skipped)`
                  : ""}
                .
              </p>
            </div>
          ) : null}
          {modelsQuery.isLoading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : modelsQuery.isError ? (
            <div className="p-6">
              <ErrorState message={modelsQuery.error.message} onRetry={() => modelsQuery.refetch()} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={items.length === 0 ? "No price entries yet" : "No models match"}
                description={
                  items.length === 0 && isAdmin
                    ? "Add model prices before usage can be billed."
                    : undefined
                }
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {/* 表头与表体都从 `columns` 渲染（同一个数组，两处 map）：
                      角色决定列集合、每列的类名（含响应式藏列）都在 display.ts 里，
                      这里只负责把 descriptor 摊开 —— 表头/表体错位在构造上不可能。 */}
                  {columns.map((column) => (
                    <TableHead key={column.key} className={column.headClassName}>
                      {column.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item) => (
                  <TableRow key={item.id}>
                    {columns.map((column) => (
                      <TableCell key={column.key} className={column.cellClassName}>
                        {cellRenderers[column.key](item)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {/* 分层规则说明（批次 L，2026-09-21 用户裁决：原副标题下沉到卡片最下方、独立成条）。
              与 settings 页「These values are compile-time constants…」同款信息条。
              CardContent 是 p-0（表格齐边），故本条的左右下边距得自己给。
              末句（批次 P）：member 看到免费行为 `$0.00`，这里是对「为什么是 0」的唯一解释。 */}
          <div className="mx-6 mb-6 mt-4 flex items-start gap-2 rounded-md border border-muted bg-muted/40 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              USD per 1M tokens. Arrows show short → long tiers: short = input ≤ 128K tokens,
              long = input &gt; 128K (longer context bills both input and output at the long
              rate); cached = input served from cache. A model showing <code>$0.00</code> is
              currently free.
            </p>
          </div>
        </CardContent>
      </Card>

      <ModelFormDialog
        open={formOpen || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setFormOpen(false);
            setEditing(null);
          }
        }}
        editing={editing ?? undefined}
      />

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
        title="Delete price entry"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Delete the price entry for <strong>{deleting?.model}</strong>? Requests to a model
            without a price entry are not billed — usage is recorded with a warning.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={deleteModel.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteModel.isPending}
              onClick={() => {
                if (deleting) {
                  deleteModel.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
                }
              }}
            >
              {deleteModel.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </Dialog>
    </PageContainer>
  );
}
