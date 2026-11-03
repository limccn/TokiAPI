// 价格表管理模块（M4 4.1）：Zod schema + 类型定义。
// 读（GET）任何已登录用户可用（批次 P，D18/D20：member 只读、服务端按角色投影）；
// 写（POST/PATCH/DELETE）仍仅 admin —— 分权落在 router.ts，且**依赖注册顺序**，见该文件头。
// 单价单位：USD / 每百万 tokens（与 seed.sql 一致）；0 表示免费模型。
// 分层（M9）：未缓存输入 tokens > 128,000 时输入与输出均取 long 档，否则 short 档；缓存命中输入按 cached 计。
import { z } from "zod";

const priceField = z.number().min(0);

/** 模型级输出上限（tokens，09-01-stg-glm-ccswitch-fix）：NULL ≡ 不限制。
 * 请求 max_tokens 超上限时 proxy 层 clamp（防慢模型长生成撞上游超时）。 */
export const maxOutputTokensSchema = z.number().int().positive().nullable();

// ⚠ 创建路径**刻意不暴露** freeMode / hiddenFromMembers（批次 P，D17/D18）：新行一律取列默认
// （false）。两个标记是"存量行的运维开关"，不是建档字段 —— 表单也不渲染它们。
export const createModelInputSchema = z.object({
  model: z.string().min(1).max(200),
  inputPriceShort: priceField,
  inputPriceLong: priceField,
  inputPriceCached: priceField,
  outputPriceShort: priceField,
  outputPriceLong: priceField,
  maxOutputTokens: maxOutputTokensSchema.optional(),
});

export const updateModelInputSchema = z
  .object({
    inputPriceShort: priceField.optional(),
    inputPriceLong: priceField.optional(),
    inputPriceCached: priceField.optional(),
    outputPriceShort: priceField.optional(),
    outputPriceLong: priceField.optional(),
    // 显式传 null = 重置为不限制（省略 = 不改动）
    maxOutputTokens: maxOutputTokensSchema.optional(),
    // 批次 P 的两个行控制（D17/D19）：省略 = 不改动；只传 `{freeMode:true}` 必须能过 —— 见下面的 refine
    freeMode: z.boolean().optional(),
    hiddenFromMembers: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.inputPriceShort !== undefined ||
      v.inputPriceLong !== undefined ||
      v.inputPriceCached !== undefined ||
      v.outputPriceShort !== undefined ||
      v.outputPriceLong !== undefined ||
      v.maxOutputTokens !== undefined ||
      // ⚠ 新增字段必须**同步**加进本 refine：漏了的话 `PATCH {freeMode:true}` 直接 400
      // （"At least one field is required"），而单看代码完全看不出问题。
      v.freeMode !== undefined ||
      v.hiddenFromMembers !== undefined,
    { message: "At least one field is required" },
  );

export const modelIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ============= 输出 Schemas =============

export const modelResponseSchema = z.object({
  id: z.number().int(),
  model: z.string(),
  // 价格字段恒为**非空 number**（批次 P，D20）：member 拿到的是被**服务端置 0** 的价格，
  // 不是 null / 省略 ⇒ 全站（前端格式化、用量页、明细表）都不必处理"价格缺失"。
  inputPriceShort: z.number(),
  inputPriceLong: z.number(),
  inputPriceCached: z.number(),
  outputPriceShort: z.number(),
  outputPriceLong: z.number(),
  // 模型级输出上限（null ≡ 不限制）
  maxOutputTokens: z.number().int().positive().nullable(),
  // 批次 P（D17）：免费模式标记 —— 库里的 5 个价列**不是**生效价，计费侧按标记取有效价。
  freeMode: z.boolean(),
  // 批次 P（D18）：对 member 隐藏 —— member 的响应用**过滤掉整行**表达，故该字段对其恒为 false
  // （admin 视角才可能读到 true）。
  hiddenFromMembers: z.boolean(),
  createdAt: z.string(), // ISO
  updatedAt: z.string(), // ISO
});

export const listModelsOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(modelResponseSchema),
  total: z.number().int(),
});

export const createModelOutputSchema = z.object({
  success: z.literal(true),
  model: modelResponseSchema,
});

export const updateModelOutputSchema = z.object({
  success: z.literal(true),
  model: modelResponseSchema,
});

export const deleteModelOutputSchema = z.object({
  success: z.literal(true),
});

// ============= OpenRouter 同步（10-16-openrouter-price-sync，design §4.1）=============

/** 同步跳过明细（reason 稳定字符串：前端/日志可按值分支，勿改措辞）。 */
export const syncSkippedSchema = z.object({
  model: z.string(),
  reason: z.string(),
});

export const syncOpenrouterOutputSchema = z.object({
  success: z.literal(true),
  /** 已有行被刷价的条数。 */
  synced: z.number().int().min(0),
  /** 白名单新插的行数（幂等：行已存在时 0）。 */
  inserted: z.number().int().min(0),
  /** 未匹配/跳过明细（no-slug / missing-from-or / no-text-pricing / allowlist-missing-from-or）。 */
  skipped: z.array(syncSkippedSchema),
  /** 价格基准源（审计回溯用；当前恒 "openrouter"）。 */
  source: z.string(),
  /** 本次 OR 目录抓取时刻（ISO）。 */
  fetchedAt: z.string(),
});

// ============= 类型导出 =============

export type CreateModelInput = z.infer<typeof createModelInputSchema>;
export type UpdateModelInput = z.infer<typeof updateModelInputSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;
export type SyncOpenrouterOutput = z.infer<typeof syncOpenrouterOutputSchema>;
