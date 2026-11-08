// 赠金发放内核（09-16-signup-bonus-grant；11-08-reward-semantics-overhaul 改语义）。
//
// 三档赠金的触发点与「账号绑定动作」一一对应（语义真源见 PRD 语义矩阵）：
// - signup_bonus：**手机号验证**（手机号注册成功 / 注册后绑定手机）—— 挂 phone-number 插件
//   的 callbackOnVerification。建号本身**不发**（邮箱注册与 GitHub 注册建号时不再赠）。
// - email_verify_bonus：**邮箱绑定并验证**（复用 afterEmailVerification 钩子，开关语义不变）。
// - github_bind_bonus：**注册后绑定 GitHub**（account.create.after 且 providerId === "github"，
//   且用户已有非 GitHub 注册证据 —— 见 grantGithubBindBonus）。
//
// 四个关键设计（改动前先读，否则会破坏幂等或原子性）：
//
// 1. 为什么是 db.batch：加余额与写流水必须在同一个 D1 batch（隐式事务）里 —— 两者要么都成、
//    要么都不成。既有 adjustUserBalance（billing.ts）是「先 UPDATE 再独立 insert」两步非原子，
//    本函数刻意不复用那条路径，避免「钱加了但流水丢了」的对账缺口。
//
// 2. 为什么条件 UPDATE + onConflictDoNothing：条件 UPDATE（WHERE marker IS NULL）是原子
//    读改写，并发两次触发只有一个能命中（D1 batch 单线程执行）；onConflictDoNothing 配合
//    balance_tx_bonus_once_idx 部分唯一索引，挡住「标记列被清空后重复写流水」。
//    双重保险，不依赖应用层判重。
//
// 3. 为什么 fail-open：钩子抛异常会让注册/验证端点返回 5xx —— 而用户行此时已落库，
//    用户会看到「注册失败但账号其实存在」，是最难排查的一类状态。赠金永远不能让主流程失败。
//
// 4. 为什么资格判据（users.bonus_eligible）是 batch **之外**的一次预读（D5）：把
//    `bonus_eligible = true` 塞进条件 UPDATE 的 WHERE 看似更省一次查询，但 batch 的两条语句
//    各自独立执行 —— 资格为 false 且该档从未发放时，UPDATE 命中 0 行（钱没加），而
//    insert 不冲突（不存在旧流水）⇒ 流水照写。结果：账本多一条赠金、余额没变，恰好是最难
//    对账的缺口。资格只在迁移里翻转一次、运行时无写路径，判据与 batch 之间无可观测竞态。
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db";
import { accounts, balanceTx, users } from "../db/schema";
import type { Logger } from "./logger";

/** 赠金默认金额（USD）：未配置 env 时的 fallback（开箱即送）。 */
export const DEFAULT_SIGNUP_BONUS = 5;
export const DEFAULT_EMAIL_VERIFY_BONUS = 5;
export const DEFAULT_GITHUB_BIND_BONUS = 5;

/** 赠金档位（同时是 balance_tx.type 取值与部分唯一索引的判据）。 */
export type BonusType = "signup_bonus" | "email_verify_bonus" | "github_bind_bonus";

/** type → 幂等标记列（条件 UPDATE 的 WHERE 依据）的唯一真源。 */
const BONUS_MARKERS = {
  signup_bonus: users.signupBonusGrantedAt,
  email_verify_bonus: users.emailVerifyBonusGrantedAt,
  github_bind_bonus: users.githubBindBonusGrantedAt,
} as const;

/** type → 条件 UPDATE 要写入的标记列（与 BONUS_MARKERS 一一对应，改一处必须改另一处）。 */
function markerAssignment(
  type: BonusType,
  now: Date,
): {
  signupBonusGrantedAt: Date;
} | {
  emailVerifyBonusGrantedAt: Date;
} | {
  githubBindBonusGrantedAt: Date;
} {
  switch (type) {
    case "signup_bonus":
      return { signupBonusGrantedAt: now };
    case "email_verify_bonus":
      return { emailVerifyBonusGrantedAt: now };
    case "github_bind_bonus":
      return { githubBindBonusGrantedAt: now };
  }
}

export interface GrantBonusResult {
  /** 本次是否实际发放（false = 金额 <= 0 短路 / 该档已发过）。 */
  granted: boolean;
  /** 发放后余额；未发放为 null。 */
  balance: number | null;
}

/**
 * 解析赠金金额（USD）。语义（对应 PRD R4）：
 * - 未配置（undefined / 空白串）→ fallback（默认值，开箱即送）
 * - 配了但非有限数 / <= 0 → 0（显式关掉；非法配置 fail-safe 到「不赠」而非「照赠」）
 * - 合法正数 → 四舍五入到分（避免 REAL 浮点噪声进余额）
 *
 * 与 parseRetentionDays（cleanup.ts）同形，但**非法值回退目标不同**：保留天数非法回退到
 * 「默认天数」（无害），赠金金额涉及钱，回退方向必须是少发而非多发。
 */
export function parseBonusAmount(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.round(parsed * 100) / 100;
}

/**
 * 邮箱验证功能总开关（EMAIL_VERIFICATION_ENABLED env；与 isGlobalCacheEnabled 同形）：
 * true/1/yes/on（大小写不敏感）才开启；缺省/其他值 = 关闭。
 * 关闭时 src/lib/auth.ts 的整个 emailVerification 段不配置（含 sendOnSignUp 与验证赠金钩子）。
 */
export function isEmailVerificationEnabled(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/**
 * 发放一次赠金（幂等 + 原子）。见文件头四条设计说明。
 *
 * **刻意不做资格判断**（users.bonus_eligible）：本函数是纯幂等发放原语，测试与未来运维工具
 * 直接用它；资格判据在包装层 grantBonusFailOpen 的预读里（D5）。
 *
 * @param amount 已解析的金额（<= 0 直接短路，不动余额、不写流水、不置标记）
 * @returns granted=true 时为本次实际发放（含发放后余额）；false 为短路或已发放过
 */
export async function grantBonusOnce(
  db: Db,
  userId: number,
  type: BonusType,
  amount: number,
  note: string,
): Promise<GrantBonusResult> {
  if (amount <= 0) {
    return { granted: false, balance: null };
  }

  const now = new Date();
  const marker = BONUS_MARKERS[type];

  // 单次 batch（D1 隐式事务）：条件 UPDATE 与流水 insert 原子成组。
  // 条件 UPDATE 未命中（该档已发过）时 insert 仍会执行，但被部分唯一索引 +
  // onConflictDoNothing 挡下 —— 不会多写一行流水。
  const [updated] = await db.batch([
    db
      .update(users)
      .set({
        balance: sql`${users.balance} + ${amount}`,
        ...markerAssignment(type, now),
        updatedAt: now,
      })
      .where(and(eq(users.id, userId), isNull(marker)))
      .returning({ balance: users.balance }),
    db
      .insert(balanceTx)
      .values({ userId, amount, type, note, createdAt: now })
      .onConflictDoNothing(),
  ]);

  const row = updated[0];
  return row ? { granted: true, balance: row.balance } : { granted: false, balance: null };
}

/**
 * 注册赠金（11-08 起 = **手机验证赠金**）：挂在 Better Auth phone-number 插件的
 * `callbackOnVerification`，覆盖「手机号注册成功」与「已登录用户绑定手机」两条路径。
 * 建号（邮箱注册 / GitHub 注册）**不再发放**；SMS 关闭的部署上本档结构性不触发。
 * fail-open：任何异常只记 error 日志，绝不抛。
 *
 * env 参数按需收窄为结构类型（同 createDb 的 { DB } 形态）：只读一个键，
 * 同时让测试可直接传入 `{ SIGNUP_BONUS_AMOUNT: "0" }` 覆盖金额分支（无需造整个 Env）。
 */
export async function grantSignupBonus(
  env: { SIGNUP_BONUS_AMOUNT?: string },
  db: Db,
  logger: Logger,
  userId: number,
): Promise<void> {
  await grantBonusFailOpen(db, logger, userId, "signup_bonus", {
    raw: env.SIGNUP_BONUS_AMOUNT,
    fallback: DEFAULT_SIGNUP_BONUS,
    note: "signup bonus",
  });
}

/**
 * 邮箱赠金（11-08 起语义 = **邮箱绑定赠金**）：挂在 Better Auth
 * emailVerification.afterEmailVerification。覆盖「手机号账号注册第三屏绑邮箱并验证」与
 * 「资料页后续绑邮箱并验证」。fail-open：同上。
 */
export async function grantEmailVerifyBonus(
  env: { EMAIL_VERIFY_BONUS_AMOUNT?: string },
  db: Db,
  logger: Logger,
  userId: number,
): Promise<void> {
  await grantBonusFailOpen(db, logger, userId, "email_verify_bonus", {
    raw: env.EMAIL_VERIFY_BONUS_AMOUNT,
    fallback: DEFAULT_EMAIL_VERIFY_BONUS,
    note: "email verified bonus",
  });
}

/**
 * GitHub 绑定赠金（11-08 新增）。只有「注册后绑定」算 —— 判据是建 github 账户时用户
 * **已具备非 GitHub 注册证据**：`users.phone_number` 非空，或存在
 * `accounts.provider_id = 'credential'` 的行。
 *
 * GitHub OAuth 首登（OAuth 直接注册）时用户既无 phone_number 也无 credential 行 ⇒ 不发（D2）。
 * 隐式关联（同邮箱 OAuth 登录自动挂账户）同样满足证据条件 ⇒ 发放；它是真实的绑定动作。
 * 判定读的是**账户表与用户行**，不是请求体/URL —— 无请求态启发式，纯库内事实。
 *
 * 非 `github` 的 provider 一律静默跳过（不是配置错误，不写日志、不查库）。
 */
export async function grantGithubBindBonus(
  env: { GITHUB_BIND_BONUS_AMOUNT?: string },
  db: Db,
  logger: Logger,
  userId: number,
  providerId: string,
): Promise<void> {
  if (providerId !== "github") {
    return;
  }
  await grantBonusFailOpen(db, logger, userId, "github_bind_bonus", {
    raw: env.GITHUB_BIND_BONUS_AMOUNT,
    fallback: DEFAULT_GITHUB_BIND_BONUS,
    note: "github linked bonus",
    precondition: {
      reason: "signup_evidence_missing",
      check: async (row) => {
        if (row.phoneNumber !== null) {
          return true;
        }
        const credential = await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
          .limit(1);
        return credential.length > 0;
      },
    },
  });
}

/** 三档包装的共用实现：解析金额 → 资格/前提预读 → 发放 → 记录结果；整段 try/catch（fail-open）。 */
async function grantBonusFailOpen(
  db: Db,
  logger: Logger,
  userId: number,
  type: BonusType,
  opts: {
    raw: string | undefined;
    fallback: number;
    note: string;
    /** 类型专属的业务前提（目前只有 GitHub 绑定档使用）。false = 不发放。 */
    precondition?: {
      check: (row: { phoneNumber: string | null }) => Promise<boolean>;
      reason: string;
    };
  },
): Promise<void> {
  try {
    const amount = parseBonusAmount(opts.raw, opts.fallback);
    if (amount <= 0) {
      // 显式关闭（金额 0/非法）不是异常：info 级留痕即可，不刷屏。
      // 契约：金额跳过**不带** reason（与策略性跳过区分），标记保持 NULL（配置恢复后仍可发放）。
      logger.info("bonus_grant_skipped", { userId, type, amount });
      return;
    }

    // 资格判据（D5）：一次预读，三档共用。只取需要的两列，不把无关字段带进内存。
    const userRow = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { bonusEligible: true, phoneNumber: true },
    });
    if (!userRow) {
      // 钩子理论上不会给不存在的用户发奖；夹具/异常暴露时不静默加钱（也就不会撞 FK 噪声）
      logger.info("bonus_grant_skipped", { userId, type, reason: "user_missing" });
      return;
    }
    if (!userRow.bonusEligible) {
      // 存量账号冻结（11-08 迁移回填 false）：三档一律不发，即使绑手机/验邮箱/绑 GitHub。
      logger.info("bonus_grant_skipped", { userId, type, reason: "ineligible" });
      return;
    }
    if (opts.precondition && !(await opts.precondition.check(userRow))) {
      logger.info("bonus_grant_skipped", { userId, type, reason: opts.precondition.reason });
      return;
    }

    const result = await grantBonusOnce(db, userId, type, amount, opts.note);
    if (result.granted) {
      logger.info("bonus_granted", { userId, type, amount, balance: result.balance });
    } else {
      logger.info("bonus_already_granted", { userId, type, amount });
    }
  } catch (error) {
    // 赠金失败绝不上抛：注册/验证主流程优先（fail-open）。注意这只保证「不阻断主流程」，
    // 不保证「照发」—— 预读抛错时同样不发钱。
    logger.error("bonus_grant_failed", { userId, type, error: String(error) });
  }
}
