// 事务邮件通道单测（08-27-email-notification AC0/AC1/AC2）：stub fetch 捕获出站请求，无 DB。
//
// 断言纪律：短路分支断言的是**零出站请求**（而不是「抛没抛错」）—— 通道最危险的失败形态是把信
// 发给了不该发的人（未配置 / 白名单外）；失败分支断言的是**抛出**（而不是「日志里有错误」）——
// 交互式端点靠这个抛出才对用户可见（design §2）。
//
// 与 AC6（本地真实投递）的分工：本文件只验证「出站请求的形状与分支裁决」，真到达收件箱由人工步骤覆盖。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMAIL_FROM,
  EMAIL_FROM_NAME,
  EMAIL_TIMEOUT_MS,
  parseEmailAllowlist,
  sendMail,
  verificationEmail,
} from "../src/lib/email";
import type { Logger } from "../src/lib/logger";

interface LogEvent {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

function capturingLogger(): { logger: Logger; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const record =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>) => {
      events.push(fields !== undefined ? { level, message, fields } : { level, message });
    };
  return {
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
    events,
  };
}

interface OutboundMail {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  signal: AbortSignal | null;
  body: Record<string, unknown>;
}

/**
 * 用 canned Resend 响应替换全局 fetch，并返回出站请求记录（**记录为空 = 零出站请求**）。
 * 与 tests/proxy-pipeline.test.ts 的 stubUpstreamFetch 同法（miniflare 内主 worker 与测试同 isolate）。
 */
function stubResend(respond: (req: OutboundMail) => Response): OutboundMail[] {
  const calls: OutboundMail[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const captured: OutboundMail = {
        url: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("Authorization"),
        contentType: headers.get("Content-Type"),
        signal: init?.signal ?? null,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(captured);
      return respond(captured);
    }),
  );
  return calls;
}

function resendAccepted(id = "resend-msg-id-1"): Response {
  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** 出站请求体（一次投递一封，取第一条）。 */
function only(calls: OutboundMail[]): OutboundMail {
  const first = calls[0];
  if (first === undefined) {
    throw new Error("expected exactly one outbound request, got none");
  }
  expect(calls).toHaveLength(1);
  return first;
}

const MAIL = {
  to: "user@example.com",
  subject: "Hello",
  html: "<p>hi</p>",
  text: "hi",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseEmailAllowlist（逗号分隔 → 归一化名单）", () => {
  it("缺失 / 空串 / 纯空白 → 空数组（= 全放行）", () => {
    expect(parseEmailAllowlist(undefined)).toEqual([]);
    expect(parseEmailAllowlist("")).toEqual([]);
    expect(parseEmailAllowlist("   ")).toEqual([]);
    expect(parseEmailAllowlist(" , , ")).toEqual([]);
  });

  it("trim + 小写归一（大小写不敏感比对的前提）", () => {
    expect(parseEmailAllowlist(" Dev@LMLH.net , Ops@lmlh.net ")).toEqual([
      "dev@lmlh.net",
      "ops@lmlh.net",
    ]);
  });

  it("空项被剔除，单元素名单仍成立", () => {
    expect(parseEmailAllowlist("dev@lmlh.net,")).toEqual(["dev@lmlh.net"]);
    expect(parseEmailAllowlist(",dev@lmlh.net,,")).toEqual(["dev@lmlh.net"]);
  });
});

describe("verificationEmail（模板）", () => {
  const URL_ = "http://localhost:5173/verify-email?token=abc.def.ghi&callbackURL=%2Fdashboard";

  it("html 与 text 都含同一条链接（含 token），有效期说明在同一条口径上", () => {
    const mail = verificationEmail(URL_);
    expect(mail.subject).toContain("Verify your email");
    expect(mail.html).toContain(URL_);
    expect(mail.text).toContain(URL_);
    // 有效期（1 小时）与 auth.ts 的 expiresIn: 60 * 60 同一口径
    expect(mail.html).toContain("expires in 1 hour");
    expect(mail.text).toContain("expires in 1 hour");
  });

  it("text 版无 HTML 标签（纯文本客户端不该看到标签）", () => {
    const mail = verificationEmail(URL_);
    expect(mail.text).not.toMatch(/<[a-z/]/i);
    expect(mail.html).toMatch(/<html/i);
  });

  it("url 不进 subject（主题行带 token 会泄进通知预览、伤投递）", () => {
    const mail = verificationEmail(URL_);
    expect(mail.subject).not.toContain("token=");
  });

  it("含「非本人操作请忽略」的说明（避免用户误以为账号被入侵）", () => {
    const mail = verificationEmail(URL_);
    expect(mail.text.toLowerCase()).toContain("ignore this email");
    expect(mail.html.toLowerCase()).toContain("ignore this email");
  });
});

describe("sendMail：短路分支（不抛错、零出站）", () => {
  it("AC0：未配置 RESEND_API_KEY（缺失 / 空白）→ 零出站请求 + email_not_configured", async () => {
    for (const env of [{}, { RESEND_API_KEY: "" }, { RESEND_API_KEY: "   " }]) {
      const calls = stubResend(() => resendAccepted());
      const { logger, events } = capturingLogger();

      await expect(sendMail(env, logger, MAIL)).resolves.toBeUndefined();

      expect(calls).toHaveLength(0);
      expect(events.map((e) => e.message)).toEqual(["email_not_configured"]);
      expect(events[0]?.fields?.["to"]).toBe(MAIL.to);
      vi.unstubAllGlobals();
    }
  });

  it("AC1：名单外收件人 → 零出站请求 + email_skipped_allowlist（刻意不抛错）", async () => {
    const calls = stubResend(() => resendAccepted());
    const { logger, events } = capturingLogger();

    await expect(
      sendMail(
        { RESEND_API_KEY: "re_test", EMAIL_ALLOWED_RECIPIENTS: "dev@lmlh.net,ops@lmlh.net" },
        logger,
        MAIL,
      ),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    expect(events.map((e) => e.message)).toEqual(["email_skipped_allowlist"]);
  });

  it("AC1：名单内（大小写与空白不敏感）→ 正常放行", async () => {
    const calls = stubResend(() => resendAccepted());
    const { logger } = capturingLogger();

    await sendMail(
      { RESEND_API_KEY: "re_test", EMAIL_ALLOWED_RECIPIENTS: " USER@EXAMPLE.COM , dev@lmlh.net" },
      logger,
      MAIL,
    );

    expect(calls).toHaveLength(1);
  });

  it("AC1：白名单缺失 / 空串 → 全放行（prod 语义）", async () => {
    for (const raw of [undefined, ""]) {
      const calls = stubResend(() => resendAccepted());
      const { logger } = capturingLogger();

      await sendMail({ RESEND_API_KEY: "re_test", EMAIL_ALLOWED_RECIPIENTS: raw }, logger, MAIL);

      expect(calls).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });
});

describe("sendMail：成功路径（出站请求形态）", () => {
  it("AC0：POST https://api.resend.com/emails，Bearer key，body 含 from/to/subject/html/text", async () => {
    const calls = stubResend(() => resendAccepted("resend-id-42"));
    const { logger, events } = capturingLogger();

    await sendMail({ RESEND_API_KEY: "re_secret_key" }, logger, MAIL);

    const req = only(calls);
    expect(req.url).toBe("https://api.resend.com/emails");
    expect(req.method).toBe("POST");
    expect(req.authorization).toBe("Bearer re_secret_key");
    expect(req.contentType).toBe("application/json");
    expect(req.body["from"]).toBe(`${EMAIL_FROM_NAME} <${EMAIL_FROM}>`);
    // Resend 规范形态：单收件人也用数组
    expect(req.body["to"]).toEqual([MAIL.to]);
    expect(req.body["subject"]).toBe(MAIL.subject);
    expect(req.body["html"]).toBe(MAIL.html);
    expect(req.body["text"]).toBe(MAIL.text);

    // 成功日志带 Resend 返回的 id（排障时用来在控制台对账）
    expect(events.map((e) => e.message)).toEqual(["email_sent"]);
    expect(events[0]?.fields?.["id"]).toBe("resend-id-42");
  });

  it("EMAIL_FROM 可覆盖发件地址（自部署者用自己的已验证域名）", async () => {
    const calls = stubResend(() => resendAccepted());
    const { logger } = capturingLogger();

    await sendMail(
      { RESEND_API_KEY: "re_test", EMAIL_FROM: "  notify@mail.example.com  " },
      logger,
      MAIL,
    );

    expect(only(calls).body["from"]).toBe(`${EMAIL_FROM_NAME} <notify@mail.example.com>`);
  });

  it("EMAIL_FROM 空白 / 缺失 → 回落内置地址（现有部署行为不变）", async () => {
    for (const override of [undefined, "", "   "]) {
      const calls = stubResend(() => resendAccepted());
      const { logger } = capturingLogger();

      await sendMail({ RESEND_API_KEY: "re_test", EMAIL_FROM: override }, logger, MAIL);

      expect(only(calls).body["from"]).toBe(`${EMAIL_FROM_NAME} <${EMAIL_FROM}>`);
      vi.unstubAllGlobals();
    }
  });

  it("出站请求带 AbortSignal（超时上界不悬空），且信号有期限", async () => {
    const calls = stubResend(() => resendAccepted());
    const { logger } = capturingLogger();

    await sendMail({ RESEND_API_KEY: "re_test" }, logger, MAIL);

    const req = only(calls);
    expect(req.signal).toBeInstanceOf(AbortSignal);
    // 不实等 10s：这里只钉住「信号已挂上且尚未中止」这一结构事实；
    // 「到点真的 abort」由 workerd 的 AbortSignal.timeout 语义保证，并由下面的中止分支覆盖传播路径。
    expect(req.signal?.aborted).toBe(false);
    expect(EMAIL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("成功响应体缺 id / 不可解析 → 仍算成功（邮件已被受理，不得反悔成失败）", async () => {
    for (const response of [
      new Response("not json", { status: 200 }),
      new Response(JSON.stringify({ noId: true }), { status: 200 }),
    ]) {
      const calls = stubResend(() => response);
      const { logger, events } = capturingLogger();

      await expect(sendMail({ RESEND_API_KEY: "re_test" }, logger, MAIL)).resolves.toBeUndefined();

      expect(calls).toHaveLength(1);
      expect(events.map((e) => e.message)).toEqual(["email_sent"]);
      expect(events[0]?.fields?.["id"]).toBeNull();
      vi.unstubAllGlobals();
    }
  });
});

describe("sendMail：失败路径（记日志后抛出）", () => {
  it("AC2：非 2xx（422）→ 抛出 + email_send_failed 带状态码与正文", async () => {
    const calls = stubResend(
      () =>
        new Response(JSON.stringify({ statusCode: 422, message: "domain_not_verified" }), {
          status: 422,
        }),
    );
    const { logger, events } = capturingLogger();

    await expect(sendMail({ RESEND_API_KEY: "re_test" }, logger, MAIL)).rejects.toThrow(/422/);

    expect(calls).toHaveLength(1);
    const failed = events.find((e) => e.message === "email_send_failed");
    expect(failed?.level).toBe("error");
    expect(failed?.fields?.["status"]).toBe(422);
    expect(String(failed?.fields?.["error"])).toContain("domain_not_verified");
  });

  it("AC2：网络异常 → 抛出 + email_send_failed", async () => {
    const calls = stubResend(() => {
      throw new Error("network down");
    });
    const { logger, events } = capturingLogger();

    await expect(sendMail({ RESEND_API_KEY: "re_test" }, logger, MAIL)).rejects.toThrow(
      "network down",
    );

    expect(calls).toHaveLength(1);
    expect(
      String(events.find((e) => e.message === "email_send_failed")?.fields?.["error"]),
    ).toContain("network down");
  });

  it("AC2：超时中止（AbortSignal.timeout 产生的 TimeoutError）→ 同样抛出", async () => {
    stubResend(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const { logger, events } = capturingLogger();

    await expect(sendMail({ RESEND_API_KEY: "re_test" }, logger, MAIL)).rejects.toThrow(
      /timeout/i,
    );
    expect(events.find((e) => e.message === "email_send_failed")?.level).toBe("error");
  });

  it("错误正文读取失败不得吞掉状态码（09-21 批次 N 的教训）", async () => {
    // 只实现 fetch 需要的三个成员：ok/status/text；text() 抛错 = 正文流断掉
    const brokenBody = {
      ok: false,
      status: 502,
      text: async () => {
        throw new Error("stream reset");
      },
    } as unknown as Response;
    stubResend(() => brokenBody);
    const { logger, events } = capturingLogger();

    await expect(sendMail({ RESEND_API_KEY: "re_test" }, logger, MAIL)).rejects.toThrow(/502/);

    const failed = events.find((e) => e.message === "email_send_failed");
    expect(failed?.fields?.["status"]).toBe(502);
    expect(String(failed?.fields?.["error"])).toContain("unreadable");
  });

  it("失败正文入日志时有上界（≤ 200 字符），状态码另立字段不受正文长度影响", async () => {
    stubResend(() => new Response("x".repeat(5000), { status: 500 }));
    const { logger, events } = capturingLogger();

    // 状态码必须在**抛出物**里（上游 4xx/5xx 的排障第一信息，不能只留在正文里）
    await expect(sendMail({ RESEND_API_KEY: "re_test" }, logger, MAIL)).rejects.toThrow(/500/);

    const failed = events.find((e) => e.message === "email_send_failed");
    expect(failed?.fields?.["status"]).toBe(500);
    // 正文被截断：5000 字符的响应体不得整段进日志
    const detail = String(failed?.fields?.["error"]);
    expect(detail.length).toBeLessThan(300);
    expect(detail).toContain("xxx");
  });
});
