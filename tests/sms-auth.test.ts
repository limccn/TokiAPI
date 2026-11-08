// 短信认证集成测试（11-06-sms-alicloud-auth；PRD AC1–AC18 + AC22 + AC24，design §10）。
//
// 两层，刻意分开：
//   A. **直调 `sendSmsCode`**（注入假 logger + 字面 env）：断言七个分支的**日志与出站次数**。
//      走端点验日志要拦截 console（脆、且看不出分支），这里直接对着契约断言。
//   B. **走真实端点**（`selfFetch` → Worker → Better Auth）：断言接线、库行为与副作用
//      （建号 / 邀请码消费 / 赠金 / 会话 / verification 行）。出站一律 stub 全局 fetch，
//      `calls.length === 0` 即「零出站请求」的取证。
//
// 判别性纪律（spec shared/assertion-discipline）：
//   - 每个 negative 用例先造出**会成功**的对照（有码 / 有 AK / 白名单内），再翻转单一变量；
//   - 「零出站」与「一次出站」成对出现：只断言 0 的用例在发送整体失效时也会绿；
//   - 验证码从**出站请求体**里取，不从库里取：库里取码会把「发出去的码」与「存下的码」
//     混为一谈，而二者一致正是 AC3 要钉的东西。
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db";
import { createAuth } from "../src/lib/auth";
import { accounts, balanceTx, inviteCodes, sessions, users, verifications } from "../src/db/schema";
import type { Logger } from "../src/lib/logger";
import { SMS_CODE_TTL_SECONDS, isPlaceholderEmail, normalizePhone } from "../src/lib/phone";
import { sendSmsCode } from "../src/lib/sms";
import {
  applyMigrations,
  countTxByType,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
  withSwitch,
} from "./helpers";

// Better Auth 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";

let ADMIN_ID = 0;
let inviteSeq = 0;
/** 逐用例递增的号码尾号，避免用例之间撞 UNIQUE(phone_number)。 */
let phoneSeq = 0;

beforeAll(async () => {
  await applyMigrations();
  ADMIN_ID = await setupUser("sms-admin@test.dev", 0, "admin");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================ 工具 ============================

type SmsKey =
  | "SMS_AUTH_ENABLED"
  | "SMS_ALLOWED_PHONES"
  | "SMS_SIGN_NAME"
  | "SMS_TEMPLATE_CODE"
  | "SMS_TEMPLATE_CODE_RESET"
  | "SMS_TEMPLATE_PARAM"
  | "SMS_ACCESS_KEY_ID"
  | "SMS_ACCESS_KEY_SECRET";

/**
 * 批量翻转多个 env 键（`withSwitch` 只接受单键）。纪律与 withSwitch 相同：
 * 只在 finally 里逐个还原，避免污染同文件其余依赖 pinned 值的用例。
 */
function withSms<T>(
  overrides: Partial<Record<SmsKey, string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const entries = Object.entries(overrides).filter(
    (entry): entry is [SmsKey, string] => entry[1] !== undefined,
  );
  const step = (index: number): Promise<T> => {
    const entry = entries[index];
    if (entry === undefined) {
      return fn();
    }
    return withSwitch(entry[0], entry[1], () => step(index + 1));
  };
  return step(0);
}

/** 一份「通道完全就绪」的 env（白名单空 = 全放行，号码另测）。 */
const READY_ENV: Record<SmsKey, string> = {
  SMS_AUTH_ENABLED: "true",
  SMS_ACCESS_KEY_ID: "test-ak-id",
  SMS_ACCESS_KEY_SECRET: "test-ak-secret",
  SMS_SIGN_NAME: "TokiAPI",
  SMS_TEMPLATE_CODE: "SMS_111111",
  SMS_TEMPLATE_CODE_RESET: "",
  SMS_TEMPLATE_PARAM: '{"code":"##code##","min":"5"}',
  SMS_ALLOWED_PHONES: "",
};

interface OutboundSms {
  url: URL;
  headers: Headers;
  body: string;
}

/**
 * 用 canned 阿里云响应替换全局 fetch，并记录出站请求。
 * 阿里云的成败判据是 `Success:true` + `Code:"OK"`（即使 HTTP 200）—— 见 src/lib/sms.ts 分支 6。
 */
function stubAliyun(respond?: (call: OutboundSms) => Response): OutboundSms[] {
  const calls: OutboundSms[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: OutboundSms = {
        url: new URL(String(input)),
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
      };
      calls.push(call);
      return respond === undefined ? aliyunOk() : respond(call);
    }),
  );
  return calls;
}

function aliyunOk(): Response {
  return new Response(
    JSON.stringify({ Code: "OK", Success: true, Model: { RequestId: "req-1", BizId: "biz-1" } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** 取数组首个元素（无 `!` 断言：空数组时立刻报错，而不是把 undefined 传下去）。 */
function first<Item>(items: readonly Item[]): Item {
  const value = items[0];
  if (value === undefined) {
    throw new Error("expected at least one element");
  }
  return value;
}

/** 从出站请求的 `TemplateParam` 里取出实际下发的验证码。 */
function codeFrom(call: OutboundSms): string {
  const raw = call.url.searchParams.get("TemplateParam");
  expect(raw).not.toBeNull();
  const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
  for (const value of Object.values(parsed)) {
    if (typeof value === "string" && /^\d{6}$/.test(value)) {
      return value;
    }
  }
  throw new Error(`no 6-digit code in TemplateParam: ${String(raw)}`);
}

/** 生成一个本文件内唯一的规范形号码（`+86` + 11 位：`13800` + 6 位序号）。 */
function nextPhone(): string {
  phoneSeq += 1;
  return `+8613800${String(100_000 + phoneSeq).slice(-6)}`;
}

async function insertInvite(): Promise<string> {
  const db = createDb(env);
  inviteSeq += 1;
  const code = `SMSINV${String(inviteSeq).padStart(4, "0")}`;
  await db.insert(inviteCodes).values({
    code,
    createdBy: ADMIN_ID,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return code;
}

async function inviteUsedAt(code: string): Promise<Date | null> {
  const db = createDb(env);
  const row = await db.query.inviteCodes.findFirst({
    where: eq(inviteCodes.code, code),
    columns: { usedAt: true },
  });
  return row?.usedAt ?? null;
}

/** 给已存在的用户补号码（模拟「号码已绑定」的库内形状）。 */
async function setPhone(userId: number, phoneNumber: string, verified = true): Promise<void> {
  const db = createDb(env);
  await db
    .update(users)
    .set({ phoneNumber, phoneNumberVerified: verified })
    .where(eq(users.id, userId));
}

async function userByPhone(
  phoneNumber: string,
): Promise<{ id: number; email: string; phoneNumberVerified: boolean } | undefined> {
  const db = createDb(env);
  return db.query.users.findFirst({
    where: eq(users.phoneNumber, phoneNumber),
    columns: { id: true, email: true, phoneNumberVerified: true },
  });
}

async function codeRow(phoneNumber: string) {
  const db = createDb(env);
  return db.query.verifications.findFirst({ where: eq(verifications.identifier, phoneNumber) });
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return selfFetch(`http://localhost${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const sendOtp = (phoneNumber: string, ip?: string) =>
  post(
    "/api/auth/phone-number/send-otp",
    { phoneNumber },
    ip === undefined ? {} : { "cf-connecting-ip": ip },
  );

const verifyOtp = (body: unknown, headers: Record<string, string> = {}) =>
  post("/api/auth/phone-number/verify", body, headers);

/** 取 Set-Cookie 的第一段 `k=v`（后续请求只需这一段）。 */
function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie");
  if (raw === null) {
    throw new Error("expected a Set-Cookie header");
  }
  return (raw.split(";")[0] ?? "").trim();
}

/** 错误码兼容两种形态：better-call 把 APIError 的 body 原样序列化（`{code}` 顶层）。 */
function errorCode(json: unknown): string {
  if (typeof json !== "object" || json === null) {
    return "";
  }
  const top = (json as { code?: unknown }).code;
  if (typeof top === "string") {
    return top;
  }
  const nested = (json as { error?: { code?: unknown } }).error;
  return typeof nested?.code === "string" ? nested.code : "";
}

/** 让号码持有一条有效验证码（走真实 send-otp，返回从出站请求里解析出的码）。 */
async function issueCode(phoneNumber: string): Promise<string> {
  const calls = stubAliyun();
  const res = await sendOtp(phoneNumber);
  expect(res.status).toBe(200);
  expect(calls).toHaveLength(1);
  return codeFrom(first(calls));
}

// ==================== A. sendSmsCode 的七个分支 ====================

interface LoggedEvent {
  level: "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

function captureLogger(): { logger: Logger; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  const record =
    (level: LoggedEvent["level"]) =>
    (message: string, fields?: Record<string, unknown>) => {
      events.push(fields === undefined ? { level, message } : { level, message, fields });
    };
  return {
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
    events,
  };
}

/** 一个未绑定任何库记录的号码，只用于分支直调。 */
const PHONE_A = "+8613800138001";
/** 白名单里的另一个号码（用于「不在名单内」的对照）。 */
const PHONE_B = "+8613900139002";

describe("sendSmsCode 七分支（AC2/AC3/AC4/AC5）", () => {
  it("开关关闭 → sms_disabled、零出站（防御分支：插件不注册时本不可达）", async () => {
    const { logger, events } = captureLogger();
    const calls = stubAliyun();
    await sendSmsCode(
      { SMS_AUTH_ENABLED: "false", SMS_ACCESS_KEY_ID: "id", SMS_ACCESS_KEY_SECRET: "secret" },
      logger,
      { phoneNumber: PHONE_A, code: "123456" },
    );
    expect(calls).toHaveLength(0);
    expect(events.map((event) => event.message)).toEqual(["sms_disabled"]);
    // 号码必须打码：完整号码不得进日志
    expect(events[0]?.fields?.phone).toBe("+86 138****8001");
  });

  it("AK 缺失 → sms_not_configured、零出站（合法中间态，不抛错）", async () => {
    const { logger, events } = captureLogger();
    const calls = stubAliyun();
    await sendSmsCode(
      { SMS_AUTH_ENABLED: "true", SMS_ACCESS_KEY_ID: "", SMS_ACCESS_KEY_SECRET: "" },
      logger,
      { phoneNumber: PHONE_A, code: "123456" },
    );
    expect(calls).toHaveLength(0);
    expect(events.map((event) => event.message)).toEqual(["sms_not_configured"]);
  });

  it("AC4 白名单外 → sms_skipped_allowlist、零出站；名单内 → 一次出站（成对）", async () => {
    const outside = captureLogger();
    const outCalls = stubAliyun();
    await sendSmsCode(
      { ...READY_ENV, SMS_ALLOWED_PHONES: PHONE_B },
      outside.logger,
      { phoneNumber: PHONE_A, code: "123456" },
    );
    expect(outCalls).toHaveLength(0);
    expect(outside.events.map((event) => event.message)).toEqual(["sms_skipped_allowlist"]);

    // 同一份配置只把白名单改成含本号 → 必须真发一次（否则上面的 0 是恒真假绿）
    const inside = captureLogger();
    const inCalls = stubAliyun();
    await sendSmsCode(
      { ...READY_ENV, SMS_ALLOWED_PHONES: `${PHONE_B}, ${PHONE_A}` },
      inside.logger,
      { phoneNumber: PHONE_A, code: "654321" },
    );
    expect(inCalls).toHaveLength(1);
    expect(inside.events.map((event) => event.message)).toEqual(["sms_code_sent"]);
    expect(codeFrom(first(inCalls))).toBe("654321");
  });

  it("AC5 白名单全部非法 → 全拒（fail-closed），不退化成全放行", async () => {
    const { logger, events } = captureLogger();
    const calls = stubAliyun();
    await sendSmsCode(
      { ...READY_ENV, SMS_ALLOWED_PHONES: "abc,123" },
      logger,
      { phoneNumber: PHONE_A, code: "123456" },
    );
    expect(calls).toHaveLength(0);
    expect(events.map((event) => event.message)).toEqual(["sms_skipped_allowlist"]);
  });

  it("AC3 出站请求形态：RPC 风格 query + 不传会把答案回传的字段", async () => {
    const { logger } = captureLogger();
    const calls = stubAliyun();
    await sendSmsCode(READY_ENV, logger, { phoneNumber: PHONE_A, code: "246810" });

    const call = first(calls);
    expect(call.url.host).toBe("dypnsapi.aliyuncs.com");
    expect(call.headers.get("x-acs-action")).toBe("SendSmsVerifyCode");
    expect(call.headers.get("x-acs-version")).toBe("2017-05-25");
    expect(call.headers.get("authorization")).toContain("ACS3-HMAC-SHA256");
    // 国内号形态：不带 +86（阿里云要 11 位）
    expect(call.url.searchParams.get("PhoneNumber")).toBe("13800138001");
    expect(call.url.searchParams.get("SignName")).toBe("TokiAPI");
    expect(call.url.searchParams.get("TemplateCode")).toBe("SMS_111111");
    expect(call.url.searchParams.get("TemplateParam")).toBe('{"code":"246810","min":"5"}');
    // 🔴 不传 ReturnVerifyCode（会把答案回传）、不传 CodeLength/ValidTime（B 模式下不成立）
    expect(call.url.searchParams.get("ReturnVerifyCode")).toBeNull();
    expect(call.url.searchParams.get("CodeLength")).toBeNull();
    expect(call.url.searchParams.get("ValidTime")).toBeNull();
    // Action/Version 只走头，不进 query（进了 query 会得到 SignatureDoesNotMatch）
    expect(call.url.searchParams.get("Action")).toBeNull();
    expect(call.url.searchParams.get("Version")).toBeNull();
  });

  // 阿里云五个赠送模板只差文案（100001 登录/注册 · 100002 换绑 · 100003 重置密码 ·
  // 100004 绑定 · 100005 验证），变量同为 code/min。服务端只分得清「找回密码」与「其余」，
  // 故只拆一条岔路：reset 用 SMS_TEMPLATE_CODE_RESET，空则回落主模板。
  it("模板选择：reset 用专用 CODE，登录回落主 CODE，且两者 TemplateParam 同形", async () => {
    const login = captureLogger();
    const loginCalls = stubAliyun();
    await sendSmsCode(READY_ENV, login.logger, { phoneNumber: PHONE_A, code: "111111" });
    expect(first(loginCalls).url.searchParams.get("TemplateCode")).toBe("SMS_111111");
    // 无 purpose 等同于 login（默认值），不会误用重置模板
    expect(login.events.at(-1)?.fields?.template).toBe("SMS_111111");

    // 配了专用模板 → reset 必须换 CODE；变量映射不变（五模板共用 code/min）
    const reset = captureLogger();
    const resetCalls = stubAliyun();
    await sendSmsCode(
      { ...READY_ENV, SMS_TEMPLATE_CODE_RESET: "SMS_333333" },
      reset.logger,
      { phoneNumber: PHONE_A, code: "222222", purpose: "reset" },
    );
    const resetCall = first(resetCalls);
    expect(resetCall.url.searchParams.get("TemplateCode")).toBe("SMS_333333");
    expect(resetCall.url.searchParams.get("TemplateParam")).toBe('{"code":"222222","min":"5"}');
    expect(reset.events.at(-1)?.fields?.template).toBe("SMS_333333");

    // 专用模板留空 → 回落主模板（单模板部署零配置即可用）
    const fallback = captureLogger();
    const fallbackCalls = stubAliyun();
    await sendSmsCode(READY_ENV, fallback.logger, {
      phoneNumber: PHONE_A,
      code: "333333",
      purpose: "reset",
    });
    expect(first(fallbackCalls).url.searchParams.get("TemplateCode")).toBe("SMS_111111");
  });

  it("上游 Success:false（HTTP 200）→ 抛 SmsError，不误判为成功", async () => {
    const { logger, events } = captureLogger();
    stubAliyun(
      () =>
        new Response(JSON.stringify({ Code: "ILLEGAL_MOBILE", Success: false, Message: "非法号码" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      sendSmsCode(READY_ENV, logger, { phoneNumber: PHONE_A, code: "123456" }),
    ).rejects.toMatchObject({ code: "ILLEGAL_MOBILE" });
    expect(events.map((event) => event.message)).toEqual(["sms_send_failed"]);
    // 日志里不得出现验证码
    expect(JSON.stringify(events)).not.toContain("123456");
  });

  it("签名/模板配置错误 → 抛错（静默会让「永远发不出却一直 200」成为黑洞）", async () => {
    const noSign = captureLogger();
    stubAliyun();
    await expect(
      sendSmsCode({ ...READY_ENV, SMS_SIGN_NAME: "" }, noSign.logger, {
        phoneNumber: PHONE_A,
        code: "123456",
      }),
    ).rejects.toMatchObject({ code: "SMS_CONFIG_INVALID" });
    expect(noSign.events[0]).toMatchObject({
      level: "error",
      message: "sms_config_invalid",
      fields: { field: "SMS_SIGN_NAME" },
    });

    const badTemplate = captureLogger();
    await expect(
      sendSmsCode({ ...READY_ENV, SMS_TEMPLATE_PARAM: "not-json" }, badTemplate.logger, {
        phoneNumber: PHONE_A,
        code: "123456",
      }),
    ).rejects.toMatchObject({ code: "SMS_TEMPLATE_INVALID" });
    expect(badTemplate.events[0]).toMatchObject({
      level: "error",
      message: "sms_config_invalid",
      fields: { field: "SMS_TEMPLATE_PARAM" },
    });

    // 模板里没有 ##code## 同样必须抛（否则短信照发、正文缺码）
    await expect(
      sendSmsCode({ ...READY_ENV, SMS_TEMPLATE_PARAM: '{"code":"static"}' }, captureLogger().logger, {
        phoneNumber: PHONE_A,
        code: "123456",
      }),
    ).rejects.toMatchObject({ code: "SMS_TEMPLATE_INVALID" });
  });
});

// ============================ B. 端点接线 ============================

describe("AC1 开关关闭", () => {
  it("/api/config 报 false，且 phone-number 端点结构性 404（不是「注册了但内部 no-op」）", async () => {
    // 基线（vitest.config.ts pin）就是关闭态
    const configRes = await selfFetch("http://localhost/api/config");
    const config = (await configRes.json()) as { smsAuthEnabled?: boolean };
    expect(config.smsAuthEnabled).toBe(false);

    const calls = stubAliyun();
    const res = await sendOtp(PHONE_A);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
    // 插件整段不注册 ⇒ 连 verification 行都不该出现
    expect(await codeRow(PHONE_A)).toBeUndefined();
  });
});

describe("AC2/AC4/AC5 端点级门控", () => {
  it("AC2 开关开、AK 空 → 200 且零出站，但 verification 行已建（请求真到了路由）", async () => {
    const phone = nextPhone();
    await withSms({ ...READY_ENV, SMS_ACCESS_KEY_ID: "", SMS_ACCESS_KEY_SECRET: "" }, async () => {
      const calls = stubAliyun();
      const res = await sendOtp(phone);
      expect(res.status).toBe(200);
      // 插件 send-otp 的成功体是 `{ message: "code sent" }`（不是 `{status:true}`）——
      // 客户端只看有没有 error，故这里按库的真实形态钉，防止「200 但没进路由」蒙混
      expect(await res.json()).toEqual({ message: "code sent" });
      expect(calls).toHaveLength(0);
      const row = await codeRow(phone);
      expect(row).toBeDefined();
      expect(row?.value).toMatch(/^\d{6}(:\d+)?$/);
    });
  });

  it("AC4/AC5 白名单外与全无效 → 200 但零出站（不泄露「号码不在白名单」）；对照真发一次", async () => {
    const phone = nextPhone();
    for (const allowlist of [PHONE_B, "abc,123"]) {
      await withSms({ ...READY_ENV, SMS_ALLOWED_PHONES: allowlist }, async () => {
        const calls = stubAliyun();
        const res = await sendOtp(phone);
        expect(res.status).toBe(200);
        expect(calls).toHaveLength(0);
      });
    }

    // 对照：白名单含本号 → 一次出站（否则上面两个 0 没有判别力）
    await withSms({ ...READY_ENV, SMS_ALLOWED_PHONES: phone }, async () => {
      const calls = stubAliyun();
      const res = await sendOtp(phone);
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
    });
  });
});

describe("AC6/AC15 验证码登录", () => {
  it("已绑定用户：send-otp → verify → 建会话、phoneNumberVerified 置位、码一次性", async () => {
    const phone = nextPhone();
    const userId = await setupUser(`sms-login-${phoneSeq}@test.dev`, 0);
    await setPhone(userId, phone, false);

    await withSms(READY_ENV, async () => {
      const code = await issueCode(phone);
      const res = await verifyOtp({ phoneNumber: phone, code });
      expect(res.status).toBe(200);
      const cookie = cookieFrom(res);

      // 会话可用：get-session 返回的就是这一行用户
      const sessionRes = await selfFetch("http://localhost/api/auth/get-session", {
        headers: { Origin: ORIGIN, Cookie: cookie },
      });
      expect(sessionRes.status).toBe(200);
      const session = (await sessionRes.json()) as { user?: { id?: unknown } } | null;
      expect(Number(session?.user?.id)).toBe(userId);

      const refreshed = await userByPhone(phone);
      expect(refreshed?.id).toBe(userId); // 未另建账号
      // AC6 的判据之一：验证成功会把 phoneNumberVerified 置位（夹具先置 false，
      // 否则本断言对「库根本更新了行」没有判别力）
      expect(refreshed?.phoneNumberVerified).toBe(true);
      expect(await codeRow(phone)).toBeUndefined(); // 一次性：用掉的码不留在库里
    });
  });

  it("AC15 停用账号：不建会话、无 Set-Cookie、无 session 行", async () => {
    const phone = nextPhone();
    const userId = await setupUser(`sms-disabled-${phoneSeq}@test.dev`, 0);
    await setPhone(userId, phone, true);
    const db = createDb(env);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, userId));

    await withSms(READY_ENV, async () => {
      const code = await issueCode(phone);
      const res = await verifyOtp({ phoneNumber: phone, code });
      const body = await res.text();
      // 实质判据是「没有会话」。状态码由库的 session.create.before 钩子决定
      // （返回 false ⇒ FAILED_TO_CREATE_SESSION 500），与邮箱登录路径同源；PRD 写的 401/403
      // 是期望值而非库行为 —— 故这里断言非 2xx + 零 session，不把库的内部选择钉死。
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(body).not.toContain("token");
      const rows = await db.query.sessions.findMany({ where: eq(sessions.userId, userId) });
      expect(rows).toHaveLength(0);
    });
  });
});

describe("AC7/AC8/AC9/AC24 手机号注册", () => {
  it("AC7 全链路：邀请码 → 建号 → 设密 → 赠金，且邀请码被消费", async () => {
    const phone = nextPhone();
    const invite = await insertInvite();

    await withSms(READY_ENV, async () => {
      const code = await issueCode(phone);
      const res = await verifyOtp({ phoneNumber: phone, code, inviteCode: invite });
      expect(res.status).toBe(200);
      const cookie = cookieFrom(res);

      const created = await userByPhone(phone);
      if (created === undefined) {
        throw new Error("phone signup did not create a user");
      }
      const userId = created.id;

      // 占位邮箱形态（PRD R18 / AC37 / design §13.2）：
      // `u<5 位十进制十六进制>.+86<11 位号码>@phone.invalid`。
      // 随机段不可省略（地址不由号码单独推导）；跨账号唯一性由号码列 UNIQUE 保证。
      expect(created.email).toMatch(/^u[0-9a-f]{5}\.\+86\d{11}@phone\.invalid$/);
      expect(created.email).toContain(`.+86${phone.slice(3)}@phone.invalid`);
      // 识别函数必须命中自己生成的格式（后缀判据；两处若漂移，绑定入口会静默消失）
      expect(isPlaceholderEmail(created.email)).toBe(true);

      const db = createDb(env);
      const userRow = await db.query.users.findFirst({ where: eq(users.id, userId) });
      expect(userRow?.phoneNumberVerified).toBe(true);

      // 邀请码被消费（一次性）
      expect(await inviteUsedAt(invite)).not.toBeNull();

      // 赠金：注册即赠（默认 5），流水类型 signup_bonus
      expect(await countTxByType(userId, "signup_bonus")).toBe(1);
      const bonus = await db.query.balanceTx.findFirst({
        where: and(eq(balanceTx.userId, userId), eq(balanceTx.type, "signup_bonus")),
      });
      expect(bonus?.amount).toBe(5);

      // 建号时**没有**密码（否则「Set password」入口就没有存在理由）
      expect(
        await db.query.accounts.findFirst({
          where: and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")),
        }),
      ).toBeUndefined();

      // 第二步：设置密码 → credential 行落库（AC23 链路前半，完整断言在 me-password.test.ts）
      const setRes = await post(
        "/api/me/password",
        { newPassword: "phone-pass-123" },
        { Cookie: cookie },
      );
      expect(setRes.status).toBe(200);
      const credential = await db.query.accounts.findFirst({
        where: and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")),
        columns: { password: true },
      });
      expect(credential?.password).toBeTruthy();
    });
  });

  it("AC24 两个手机号账号的占位邮箱均随机且互不相等", async () => {
    const first = nextPhone();
    const second = nextPhone();
    await withSms(READY_ENV, async () => {
      for (const phone of [first, second]) {
        const invite = await insertInvite();
        const code = await issueCode(phone);
        const res = await verifyOtp({ phoneNumber: phone, code, inviteCode: invite });
        expect(res.status).toBe(200);
        await res.text();
      }
      const a = await userByPhone(first);
      const b = await userByPhone(second);
      expect(a?.email).toMatch(/^u[0-9a-f]{5}\.\+86\d{11}@phone\.invalid$/);
      expect(b?.email).toMatch(/^u[0-9a-f]{5}\.\+86\d{11}@phone\.invalid$/);
      expect(a?.email).not.toBe(b?.email);
    });
  });

  it("AC8 缺邀请码 → 403 INVITE_CODE_REQUIRED，且未建号", async () => {
    const phone = nextPhone();
    await withSms(READY_ENV, async () => {
      const code = await issueCode(phone);
      const res = await verifyOtp({ phoneNumber: phone, code });
      const json: unknown = await res.json();
      expect(res.status).toBe(403);
      expect(errorCode(json)).toBe("INVITE_CODE_REQUIRED");
      expect(await userByPhone(phone)).toBeUndefined();
    });
  });

  it("AC9 无效邀请码 → 403 INVITE_CODE_INVALID，且未建号", async () => {
    const phone = nextPhone();
    await withSms(READY_ENV, async () => {
      const code = await issueCode(phone);
      const res = await verifyOtp({ phoneNumber: phone, code, inviteCode: "NOSUCHCODE1" });
      const json: unknown = await res.json();
      expect(res.status).toBe(403);
      expect(errorCode(json)).toBe("INVITE_CODE_INVALID");
      expect(await userByPhone(phone)).toBeUndefined();
    });
  });

  it("已消费的邀请码不能再用（一次性）", async () => {
    const used = await insertInvite();
    const first = nextPhone();
    const second = nextPhone();
    await withSms(READY_ENV, async () => {
      const code1 = await issueCode(first);
      expect((await verifyOtp({ phoneNumber: first, code: code1, inviteCode: used })).status).toBe(200);

      const code2 = await issueCode(second);
      const res = await verifyOtp({ phoneNumber: second, code: code2, inviteCode: used });
      const json: unknown = await res.json();
      expect(res.status).toBe(403);
      expect(errorCode(json)).toBe("INVITE_CODE_INVALID");
      expect(await userByPhone(second)).toBeUndefined();
    });
  });
});

describe("AC11/AC12 找回密码", () => {
  /** 造一个「有邮箱密码 + 已绑定号码」的账号（旧密码可验证，才能证明重置真的换了密码）。 */
  async function createPasswordUserWithPhone(phone: string): Promise<number> {
    const email = `sms-reset-${crypto.randomUUID().slice(0, 8)}@test.dev`;
    const signUpRes = await post("/api/auth/sign-up/email", {
      email,
      password: "old-pass-123",
      name: "reset",
      inviteCode: await insertInvite(),
    });
    expect([200, 201]).toContain(signUpRes.status);
    await signUpRes.text();
    const db = createDb(env);
    const row = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true },
    });
    if (row === undefined) {
      throw new Error("sign-up did not create a user");
    }
    await setPhone(row.id, phone);
    return row.id;
  }

  it("AC11 重置后新密码可登录、旧密码 401", async () => {
    const phone = nextPhone();
    const userId = await createPasswordUserWithPhone(phone);

    // 顺带钉 auth.ts 的接线：找回密码走 sendPasswordResetOTP ⇒ purpose=reset ⇒ 专用模板
    await withSms({ ...READY_ENV, SMS_TEMPLATE_CODE_RESET: "SMS_333333" }, async () => {
      // ① 请求重置：真发一条码（与 AC12 的「零出站」成对）
      const calls = stubAliyun();
      const requestRes = await post("/api/auth/phone-number/request-password-reset", {
        phoneNumber: phone,
      });
      expect(requestRes.status).toBe(200);
      expect(await requestRes.json()).toEqual({ status: true });
      expect(calls).toHaveLength(1);
      expect(first(calls).url.searchParams.get("TemplateCode")).toBe("SMS_333333");
      const resetCode = codeFrom(first(calls));

      // ② 用码重置
      const resetRes = await post("/api/auth/phone-number/reset-password", {
        phoneNumber: phone,
        otp: resetCode,
        newPassword: "new-pass-456",
      });
      expect(resetRes.status).toBe(200);

      // ③ 新密码可登录（同一行用户）
      const ok = await post("/api/auth/sign-in/phone-number", {
        phoneNumber: phone,
        password: "new-pass-456",
      });
      const okBody = (await ok.json()) as { user?: { id?: unknown } } | null;
      expect(ok.status).toBe(200);
      expect(Number(okBody?.user?.id)).toBe(userId);
      expect(ok.headers.get("set-cookie")).not.toBeNull();

      // ④ 旧密码 401（证明确实换掉了，而不是并存）
      const old = await post("/api/auth/sign-in/phone-number", {
        phoneNumber: phone,
        password: "old-pass-123",
      });
      await old.text();
      expect(old.status).toBe(401);
    });
  });

  // SPA 的「找回密码」页必须用 `request-password-reset` 发码，**不能**用 `send-otp`
  // （2026-11-06 独立复核抓到的真缺陷：原实现用共享 hook 的缺省端点，短信照发、
  // 验证码永远对不上）。根因是库按 identifier 分命名空间：send-otp 写裸号码，
  // request-password-reset 写 `${号码}-request-password-reset`，而 resetPassword 只查后者。
  // 这条用例把「两个端点不可互换」钉成显式契约 —— 端点层面的 AC11 绿不能证明页面对。
  it("找回码与登录码不互通：send-otp 的码重置必 OTP_NOT_FOUND（成对：重置码可重置）", async () => {
    const phone = nextPhone();
    await createPasswordUserWithPhone(phone);

    await withSms(READY_ENV, async () => {
      const calls = stubAliyun();
      const sendRes = await post("/api/auth/phone-number/send-otp", { phoneNumber: phone });
      await sendRes.text();
      expect(sendRes.status).toBe(200);
      const loginCode = codeFrom(first(calls));

      const wrongNs = await post("/api/auth/phone-number/reset-password", {
        phoneNumber: phone,
        otp: loginCode,
        newPassword: "should-not-apply-789",
      });
      const wrongJson: unknown = await wrongNs.json();
      expect(wrongNs.status).toBe(400);
      expect(errorCode(wrongJson)).toBe("OTP_NOT_FOUND");

      // 对照：同一端点换成 request-password-reset 发的码即可成功 ——
      // 证明上面的 400 来自「命名空间不同」，而不是该端点本身坏了。
      const resetCalls = stubAliyun();
      const requestRes = await post("/api/auth/phone-number/request-password-reset", {
        phoneNumber: phone,
      });
      await requestRes.text();
      expect(requestRes.status).toBe(200);
      expect(resetCalls).toHaveLength(1);
      const ok = await post("/api/auth/phone-number/reset-password", {
        phoneNumber: phone,
        otp: codeFrom(first(resetCalls)),
        newPassword: "should-apply-789",
      });
      await ok.text();
      expect(ok.status).toBe(200);
    });
  });

  it("AC12 未注册号码请求重置 → 恒 200、零出站、响应体与已注册情形一致", async () => {
    const registered = nextPhone();
    await createPasswordUserWithPhone(registered);
    const unknownPhone = nextPhone();

    await withSms(READY_ENV, async () => {
      // 已注册：一次出站
      const regCalls = stubAliyun();
      const reg = await post("/api/auth/phone-number/request-password-reset", {
        phoneNumber: registered,
      });
      const regBody = await reg.text();
      expect(reg.status).toBe(200);
      expect(regCalls).toHaveLength(1);

      // 未注册：零出站，但响应逐字节相同（没有存在性 oracle）
      const unknownCalls = stubAliyun();
      const unknown = await post("/api/auth/phone-number/request-password-reset", {
        phoneNumber: unknownPhone,
      });
      const unknownBody = await unknown.text();
      expect(unknown.status).toBe(200);
      expect(unknownCalls).toHaveLength(0);
      expect(unknownBody).toBe(regBody);
    });
  });
});

describe("AC13/AC14 尝试上限与过期", () => {
  it("AC13 连错 3 次后：第 4 次 TOO_MANY_ATTEMPTS（403），第 5 次 OTP_NOT_FOUND", async () => {
    const phone = nextPhone();
    const userId = await setupUser(`sms-attempts-${phoneSeq}@test.dev`, 0);
    await setPhone(userId, phone, true);

    await withSms(READY_ENV, async () => {
      const code = await issueCode(phone);
      const wrong = code === "000000" ? "111111" : "000000";

      // 允许 3 次尝试：前 3 次各回 400 INVALID_OTP（PRD 原文把「第 3 次」写成 403，
      // 实测库语义是「3 次用完后的下一次才 403」—— 这里按实测钉，偏差记入交付说明）
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const res = await verifyOtp({ phoneNumber: phone, code: wrong });
        const json: unknown = await res.json();
        expect(res.status).toBe(400);
        expect(errorCode(json)).toBe("INVALID_OTP");
      }

      const blocked = await verifyOtp({ phoneNumber: phone, code: wrong });
      const blockedJson: unknown = await blocked.json();
      expect(blocked.status).toBe(403);
      expect(errorCode(blockedJson)).toBe("TOO_MANY_ATTEMPTS");

      // 行已被删除 ⇒ 正确码也用不了了，错误类型随之改变
      const gone = await verifyOtp({ phoneNumber: phone, code });
      const goneJson: unknown = await gone.json();
      expect(gone.status).toBe(400);
      expect(errorCode(goneJson)).toBe("OTP_NOT_FOUND");

      // 全程没有建会话
      const db = createDb(env);
      expect(await db.query.sessions.findMany({ where: eq(sessions.userId, userId) })).toHaveLength(
        0,
      );
    });
  });

  it("AC14 过期：expires_at 置过去 → OTP_EXPIRED 且行被清理", async () => {
    const phone = nextPhone();
    const userId = await setupUser(`sms-expired-${phoneSeq}@test.dev`, 0);
    await setPhone(userId, phone, true);

    await withSms(READY_ENV, async () => {
      const code = await issueCode(phone);
      const db = createDb(env);
      // 有效期常量与 auth.ts 的 expiresIn 同源；这里直接把行推到过去
      expect(SMS_CODE_TTL_SECONDS).toBe(300);
      await db
        .update(verifications)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(verifications.identifier, phone));

      const res = await verifyOtp({ phoneNumber: phone, code });
      const json: unknown = await res.json();
      expect(res.status).toBe(400);
      expect(errorCode(json)).toBe("OTP_EXPIRED");
      expect(await codeRow(phone)).toBeUndefined();
    });
  });
});

describe("AC16/AC22 号码规范形与统一登录标识", () => {
  it("裸 11 位与 +86 归一为同一号码（前端分类器是唯一归一入口）", () => {
    expect(normalizePhone("13800138000")).toBe("+8613800138000");
    expect(normalizePhone("+8613800138000")).toBe("+8613800138000");
    expect(normalizePhone("138-0013-8000")).toBe("+8613800138000");
    expect(normalizePhone("+85213800138")).toBeNull();
  });

  it("AC16/AC22 非规范形在插件层被拒（400 INVALID_PHONE_NUMBER），且不建 verification 行", async () => {
    // 裸 11 位也在其中：服务端**只**认规范形，归一由前端 classifyLoginIdentifier 完成
    const bad = ["13800138000", "+85213800138", "+861380013800", "+8612800138000", "not-a-phone"];
    await withSms(READY_ENV, async () => {
      const calls = stubAliyun();
      for (const raw of bad) {
        const res = await sendOtp(raw);
        const json: unknown = await res.json();
        expect(res.status).toBe(400);
        expect(errorCode(json)).toBe("INVALID_PHONE_NUMBER");
        expect(await codeRow(raw)).toBeUndefined();
      }
      expect(calls).toHaveLength(0);
    });
  });

  it("AC22 邮箱面仍只认邮箱：手机号形态送 sign-in/email → 400，且零会话", async () => {
    const phone = nextPhone();
    const userId = await setupUser(`sms-email-face-${phoneSeq}@test.dev`, 0);
    await setPhone(userId, phone, true);

    const res = await post("/api/auth/sign-in/email", { email: phone, password: "whatever-123" });
    await res.text();
    expect(res.status).toBe(400);
    const db = createDb(env);
    expect(await db.query.sessions.findMany({ where: eq(sessions.userId, userId) })).toHaveLength(0);
  });
});

describe("AC17 绑定手机号", () => {
  it("登录用户 verify(updatePhoneNumber) → profile 返回该号码；绑定他人号码 → PHONE_NUMBER_EXIST", async () => {
    const targetPhone = nextPhone();
    const conflictPhone = nextPhone();

    const mine = await setupUser(`sms-bind-${phoneSeq}@test.dev`, 0);
    const other = await setupUser(`sms-other-${phoneSeq}@test.dev`, 0);
    await setPhone(other, conflictPhone, true);

    const cookie = sessionCookie(await createSession(mine));

    await withSms(READY_ENV, async () => {
      // ① 无会话 → 401（updatePhoneNumber 需要登录态；码在会话检查前已被消费）
      const anonCode = await issueCode(targetPhone);
      const anon = await verifyOtp({
        phoneNumber: targetPhone,
        code: anonCode,
        updatePhoneNumber: true,
      });
      await anon.text();
      expect(anon.status).toBe(401);

      // ② 带会话绑他人的号码 → 400 PHONE_NUMBER_EXIST
      const conflictCode = await issueCode(conflictPhone);
      const conflict = await verifyOtp(
        { phoneNumber: conflictPhone, code: conflictCode, updatePhoneNumber: true },
        { Cookie: cookie },
      );
      const conflictJson: unknown = await conflict.json();
      expect(conflict.status).toBe(400);
      expect(errorCode(conflictJson)).toBe("PHONE_NUMBER_EXIST");

      // ③ 带会话绑自己的号码 → 200，profile 读出规范形 + 已验证
      const ownCode = await issueCode(targetPhone);
      const res = await verifyOtp(
        { phoneNumber: targetPhone, code: ownCode, updatePhoneNumber: true },
        { Cookie: cookie },
      );
      expect(res.status).toBe(200);
      await res.text();

      const meRes = await selfFetch("http://localhost/api/me/profile", {
        headers: { Origin: ORIGIN, Cookie: cookie },
      });
      const me = (await meRes.json()) as {
        profile?: { phoneNumber?: unknown; phoneNumberVerified?: unknown };
      };
      expect(me.profile?.phoneNumber).toBe(targetPhone);
      expect(me.profile?.phoneNumberVerified).toBe(true);

      // ④ 同一号码不能再绑给第二个账号（跨账号唯一性）
      const secondUser = await setupUser(`sms-bind-second-${phoneSeq}@test.dev`, 0);
      const secondCookie = sessionCookie(await createSession(secondUser));
      const dupCode = await issueCode(targetPhone);
      const dup = await verifyOtp(
        { phoneNumber: targetPhone, code: dupCode, updatePhoneNumber: true },
        { Cookie: secondCookie },
      );
      const dupJson: unknown = await dup.json();
      expect(dup.status).toBe(400);
      expect(errorCode(dupJson)).toBe("PHONE_NUMBER_EXIST");
    });
  });
});

describe("AC10 认证面限流", () => {
  // 档位与 tests/auth-rate-limit.test.ts 同源：email 桶 5/60s、credential 桶 10/60s。
  // 突发一律 2×limit+1，规避固定窗口边界相位（原理见该文件头注）。
  const EMAIL_LIMIT = 5;
  const CREDENTIAL_LIMIT = 10;

  it("send-otp 落 email 桶：11 连发必现 429 + Retry-After", async () => {
    const ip = "203.0.113.211";
    stubAliyun();
    const statuses: number[] = [];
    let first429: Response | null = null;
    for (let i = 0; i < EMAIL_LIMIT * 2 + 1; i += 1) {
      const res = await post("/api/auth/phone-number/send-otp", {}, { "cf-connecting-ip": ip });
      statuses.push(res.status);
      if (res.status === 429 && first429 === null) {
        first429 = res;
      }
      await res.text();
    }
    expect(statuses).toContain(429);
    expect(first429?.headers.get("retry-after")).toBe("60");
  });

  it("verify 与 sign-in/phone-number 落 credential 桶：各自 21 连发必现 429", async () => {
    for (const [path, ip] of [
      ["/api/auth/phone-number/verify", "203.0.113.212"],
      ["/api/auth/sign-in/phone-number", "203.0.113.213"],
    ] as const) {
      stubAliyun();
      const statuses: number[] = [];
      for (let i = 0; i < CREDENTIAL_LIMIT * 2 + 1; i += 1) {
        const res = await post(path, {}, { "cf-connecting-ip": ip });
        statuses.push(res.status);
        await res.text();
      }
      expect(statuses).toContain(429);
    }
  });
});

describe("AC36 GitHub 绑定配置契约（PRD R16）", () => {
  // 手机号注册账号的邮箱是占位地址（…@phone.invalid），与 GitHub 账号的真实邮箱
  // **必然不同**。better-auth 1.7 的 linkSocial 回调默认 allowDifferentEmails=false
  // （api/routes/callback.mjs 的 EMAIL_DOES_NOT_MATCH 分支），绑定会直接失败。
  //
  // 为什么对 createAuth 的产物断言而不是走端点：真实 OAuth 往返无法在单测里跑
  // （需要 GitHub 授权码与可达的 token 端点），而**去掉这一行不会有任何现有用例变红**
  // —— 典型的静默回归点。同 tests/signup-bonus.test.ts:378 对 emailVerification 段的做法。
  it("allowDifferentEmails 放开（显式 linkSocial 的唯一前提），且不弱化隐式关联的两道默认守卫", () => {
    const auth = createAuth(env, createDb(env));
    // createAuth 的返回类型由字面量选项推导（accountLinking 被窄化成 `{ allowDifferentEmails: true }`），
    // 故用 Record 索引访问未被显式设置的键 —— 要断言的正是「这些键不该被显式设成削弱值」。
    const linking: Record<string, unknown> = auth.options.account?.accountLinking ?? {};
    expect(linking.allowDifferentEmails).toBe(true);
    // 隐式同邮箱 OAuth 登录走 oauth2/link-account.mjs，由 requireLocalEmailVerified 守卫
    // （默认 true）——它不受 allowDifferentEmails 影响，但也不能被顺手关掉。
    expect(linking.requireLocalEmailVerified).not.toBe(false);
    // 链接后默认不覆盖本地资料（默认 false）：若打开，GitHub 邮箱会顶掉占位邮箱，
    // 让「手机号账号 + 绑定 GitHub」变成一条隐式改邮箱路径。
    expect(linking.updateUserInfoOnLink).not.toBe(true);
    // 整个 accountLinking 段必须保持启用（enabled:false 会让 linkSocial 一律失败）。
    expect(linking.enabled).not.toBe(false);
  });
});
