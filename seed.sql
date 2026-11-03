-- Seed: 默认模型价格表（USD / 每百万 tokens）—— 全量同步脚本。
-- 价格来源（2026-10-16 同步）：OpenRouter API 快照 openrouter.ai/api/v1/models
--   （465 条，存档 .trellis/tasks/10-16-openrouter-price-sync/research/or-catalog-2026-10-16.json，
--   本地 Trellis 不随仓库分发）——**100% 同价策略**（用户裁决 2026-10-16）：prompt/completion
--   原值 × 1e6 直取，无视 discount（OR API pricing 字段即结算价，目录无独立 discount 键）。
-- 映射规则（OR 无源字段的补全策略）：
--   input_price_long = output_price_long = 同 short（OR 无分层价源；网关 128K 分层照计，见下）。
--   input_price_cached = pricing.input_cache_read × 1e6（快照 28+17 行全有源，无一例外）。
-- 两个显式锚（OR 无精确 slug，用户裁决 2026-10-16）：
--   gpt-5.6-codex ← openai/gpt-5.6-sol 同价；qwen3.8-max ← qwen/qwen3.8-max-0902。
-- 列：input_price_short / input_price_long / input_price_cached / output_price_short / output_price_long
--   max_output_tokens：模型级输出上限（tokens，NULL = 不限制；proxy 层 clamp 防慢模型撞上游超时）。
--     ⚠ 档位网格（09-14-admin-ui-adjustments-2 批次 Q）：非 NULL 值须落在
--     MODELCAP_BASE_TOKENS × MODELCAP_MULTIPLIER（缺省 8192 × 2 = 16384）的 **0.5 正整数倍**上，
--     否则 `npm run render:modelcaps` fail-fast（生成物存的是**档位**）。管理台的 Max output
--     下拉只提供 0.5x/1x/2x/4x/8x 五档（即 8192 / 16384 / 32768 / 65536 / 131072）；
--     1.5x、3x 等半档在构建侧合法但下拉选不到 —— 真要写就同时改下拉选项表。
--     ⚠ 只写不改下拉的后果：管理台打开该模型的编辑弹窗会**就近预选**到最近档（并列取大，
--       24,576 → 32,768），管理员一按保存库值就被改写。半档值不会被静默改写 —— 弹窗会
--       显式写出原值 —— 但「按一次保存就漂到隔壁档」仍不是想要的行为。
-- 分层规则（M9）：单次请求未缓存输入 tokens > 128,000 时输入与输出均取 long 档，否则 short 档。
--   ⚠ 官方阈值与网关固定 128K 不一致的模型（gpt-5.x=272K / claude-sonnet-4.5=200K），
--     错位区间按网关 128K 判定计费（128K~官方阈值间按 long 档多收），属已确认决策。
--   缓存价 = 官方公布的缓存命中输入价（OpenAI/Anthropic 10%、DeepSeek/Qwen 20% 量级）。
-- 2026-10-16 新增 17 行（OR 快照主流新 id，服务端白名单）：与
--   src/routes/models/lib/openrouter-sync.ts 的 OPENROUTER_INSERT_ALLOWLIST **逐字一致**
--   （键序防漂移由 tests/model-sync.test.ts 钉；按钮同步在行缺失时按同一白名单补插）。
-- 幂等语义（2026-09-11 起）：** 全量替换 ** —— 先清空 models 再按本清单重灌，
--   本文件即权威全量状态；同步 = 对任意环境（local/stg/prod）直接执行本文件。
--   ⚠ 会清除 admin 后台自定义模型及手工调整的价格/输出上限，执行前请确认。
--   D1 批量执行为原子事务（一条失败全部回滚），不会出现中间空表窗口。

DELETE FROM models;

INSERT INTO models
  (model, input_price_short, input_price_long, input_price_cached, output_price_short, output_price_long, max_output_tokens, created_at, updated_at)
VALUES
  -- OpenAI（官方分层阈值 272K > 网关 128K；128K~272K 区间按 long 档计，见头部说明）
  ('gpt-5.6-sol',     4,      4,      0.4,     20,     20,     16384, unixepoch(), unixepoch()),
  -- 锚 openai/gpt-5.6-sol 同价（OR 无 gpt-5.6-codex slug，用户裁决 2026-10-16）
  ('gpt-5.6-codex',   4,      4,      0.4,     20,     20,     16384, unixepoch(), unixepoch()),
  ('gpt-5.6-terra',   2,      2,      0.2,     12,     12,     16384, unixepoch(), unixepoch()),
  ('gpt-5.6-luna',    0.2,    0.2,    0.02,    1.2,    1.2,    16384, unixepoch(), unixepoch()),
  ('gpt-6-astra',     10,     10,     1,       50,     50,     16384, unixepoch(), unixepoch()),
  -- Anthropic（除 claude-sonnet-4.5 外官方未分层；快照 cached 价 OR 直取）
  ('claude-fable-5.1',    10,  10,  0.25,   50,  50,  16384, unixepoch(), unixepoch()),
  ('claude-fable-5',      10,  10,  1,      50,  50,  16384, unixepoch(), unixepoch()),
  ('claude-opus-5',       5,   5,   0.5,    25,  25,  16384, unixepoch(), unixepoch()),
  ('claude-opus-4.8',     5,   5,   0.5,    25,  25,  16384, unixepoch(), unixepoch()),
  ('claude-opus-4.5',     5,   5,   0.5,    25,  25,  16384, unixepoch(), unixepoch()),
  ('claude-sonnet-5',     2,   2,   0.2,    10,  10,  16384, unixepoch(), unixepoch()),
  ('claude-sonnet-4.6',    3,   3,   0.3,    15,  15,  16384, unixepoch(), unixepoch()),
  -- 官方阈值 200K，网关 128K 判档（OR 价与 short 同源，分层补全见头部映射规则）
  ('claude-sonnet-4.5',    3,   3,   0.3,    15,  15,  16384, unixepoch(), unixepoch()),
  ('claude-haiku-4.5',     1,   1,   0.1,    5,   5,   16384, unixepoch(), unixepoch()),
  -- DeepSeek（快照直取；v4-pro 为 OR 精确小数价，勿四舍五入）
  ('deepseek-v4.1-flash',  0.036,    0.036,    0.0054,    0.684,    0.684,    65536, unixepoch(), unixepoch()),
  ('deepseek-v4-pro',      0.95526,  0.95526,  0.079605,  1.91052,  1.91052, 16384, unixepoch(), unixepoch()),
  -- Qwen（qwen3.8-max 锚 qwen/qwen3.8-max-0902，OR 无裸 max slug，用户裁决 2026-10-16）
  ('qwen3.8-flash',  0.15,  0.15,  0.016,  0.47,  0.47,  32768, unixepoch(), unixepoch()),
  ('qwen3.8-27b',    0.24,  0.24,  0.05,   2.2,   2.2,   65536, unixepoch(), unixepoch()),
  ('qwen3.8-max',    2,     2,     0.25,   6,     6,     16384, unixepoch(), unixepoch()),
  -- Zhipu（GLM，官方未分层；快照直取）
  ('glm-5.3',       0.079,   0.079,   0.078,    4.8,      4.8,      32768, unixepoch(), unixepoch()),
  ('glm-5.3-flash', 0.0243,  0.0243,  0.01125,  0.9,      0.9,      65536, unixepoch(), unixepoch()),
  -- MIMO（官方未分层；快照直取）
  ('mimo-v2.5',     0.14,   0.14,   0.0028,  0.28,  0.28,  32768, unixepoch(), unixepoch()),
  ('mimo-v2.5-pro', 0.435,  0.435,  0.0036,  0.87,  0.87,  32768, unixepoch(), unixepoch()),
  -- Hy3（官方未分层；快照直取）
  ('hy3',           0.132,  0.132,  0.033,   0.528,  0.528,  65536, unixepoch(), unixepoch()),
  ('hy4-preview',   0.834,  0.834,  0.042,   2.501,  2.501,  16384,  unixepoch(), unixepoch()),
  -- kimi
  ('kimi-k2.6',     0.65,   0.65,   0.15,    3.41,    3.41,    65536, unixepoch(), unixepoch()),
  ('kimi-k3',       0.304,  0.304,  0.21,    11.936,  11.936, 16384, unixepoch(), unixepoch()),
  -- minimax
  ('minimax-m3',    0.3,    0.3,    0.06,    1.2,     1.2,     16384, unixepoch(), unixepoch()),
  -- ============ 2026-10-16 白名单新增 17 行（OR 快照主流新 id；与 OPENROUTER_INSERT_ALLOWLIST 逐字一致）============
  -- Anthropic 5.5 系
  ('claude-opus-5.5',    4,   4,   0.2,    20,  20,  16384, unixepoch(), unixepoch()),
  ('claude-sonnet-5.5',  2,   2,   0.1,    10,  10,  16384, unixepoch(), unixepoch()),
  ('claude-haiku-5.5',   0.1, 0.1,  0.01,   0.5,  0.5, 16384, unixepoch(), unixepoch()),
  -- OpenAI gpt-6 / 6.1 系 + 5.6 pro 变体
  ('gpt-6.1-sol',       2,   2,   0.1,    10,  10,  16384, unixepoch(), unixepoch()),
  ('gpt-6.1-sol-pro',   2,   2,   0.1,    10,  10,  16384, unixepoch(), unixepoch()),
  ('gpt-6-sol',         2,   2,   0.2,    10,  10,  16384, unixepoch(), unixepoch()),
  ('gpt-6-sol-pro',     2,   2,   0.2,    10,  10,  16384, unixepoch(), unixepoch()),
  ('gpt-6-luna',        0.1, 0.1,  0.01,    0.5,  0.5, 16384, unixepoch(), unixepoch()),
  ('gpt-6-luna-pro',    0.1, 0.1,  0.01,    0.5,  0.5, 16384, unixepoch(), unixepoch()),
  ('gpt-6-astra-pro',   10,  10,  1,       50,  50,  16384, unixepoch(), unixepoch()),
  ('gpt-5.6-sol-pro',   4,   4,   0.4,    20,  20,  16384, unixepoch(), unixepoch()),
  ('gpt-5.6-terra-pro',  2,   2,   0.2,    12,  12,  16384, unixepoch(), unixepoch()),
  ('gpt-5.6-luna-pro',  0.2, 0.2,  0.02,    1.2,  1.2, 16384, unixepoch(), unixepoch()),
  -- Zhipu GLM prime / flashx
  ('glm-5.3-prime',   2.8,   2.8,   0.56,   8.8,    8.8,    16384, unixepoch(), unixepoch()),
  ('glm-5.3-flashx',  0.37,  0.37,  0.09,   1.25,   1.25,   65536, unixepoch(), unixepoch()),
  -- MIMO v2.6 系
  ('mimo-v2.6-pro',   0.435,  0.435,  0.0036,  0.87,  0.87,  32768, unixepoch(), unixepoch()),
  ('mimo-v2.6-flash',  0.14,  0.14,   0.0028,  0.28,  0.28,  32768, unixepoch(), unixepoch());