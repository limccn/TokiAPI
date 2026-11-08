// 手机号纯函数层单测（11-06-sms-alicloud-auth；design §4.1 / AC 见 prd §9）。
//
// 判别性纪律（spec shared/assertion-discipline）：每个 negative 用例都给出**能通过的近邻**
// 一起断言，避免「函数恒返回 null / 恒抛错」也能全绿。
import { describe, expect, it } from "vitest";
import {
  buildPhonePlaceholderEmail,
  classifyLoginIdentifier,
  isCanonicalPhone,
  isPhoneAllowed,
  isPlaceholderEmail,
  isSmsAuthEnabled,
  maskPhone,
  normalizePhone,
  parseSmsAllowlist,
  renderTemplateParam,
  SmsTemplateError,
  toNationalNumber,
} from "../src/lib/phone";

describe("isPlaceholderEmail（占位邮箱识别，PRD R18 / AC37）", () => {
  it("新旧两种生成格式都命中（后缀判据，不依赖完整格式）", () => {
    // 新格式：u<5hex>.+86<11 位>@phone.invalid
    expect(isPlaceholderEmail("u5f3a2.+8613800138000@phone.invalid")).toBe(true);
    // 旧格式：phone-<uuid>@phone.invalid（存量行）
    expect(isPlaceholderEmail("phone-1b4e28ba-2fa1-11d2-883f-0016d3cca427@phone.invalid")).toBe(true);
    // 大小写不敏感
    expect(isPlaceholderEmail("U5F3A2.+8613800138000@PHONE.INVALID")).toBe(true);
  });

  it("普通邮箱 / 近似后缀 / 空值 ⇒ false（近邻为 true，证明不是恒 false）", () => {
    expect(isPlaceholderEmail("user@example.com")).toBe(false);
    // 近似后缀：必须以 @phone.invalid 结尾，notphone.invalid 不算
    expect(isPlaceholderEmail("user@notphone.invalid")).toBe(false);
    expect(isPlaceholderEmail("user@phone.invalid.example.com")).toBe(false);
    expect(isPlaceholderEmail("")).toBe(false);
    expect(isPlaceholderEmail(null)).toBe(false);
    expect(isPlaceholderEmail(undefined)).toBe(false);
    // 近邻：同一后缀的另一种 local part 仍命中
    expect(isPlaceholderEmail("anything@phone.invalid")).toBe(true);
  });
});

describe("normalizePhone", () => {
  it("裸 11 位 / 带 +86 / 带 86 / 带分隔符 都归一到同一规范形", () => {
    const canonical = "+8613800138000";
    expect(normalizePhone("13800138000")).toBe(canonical);
    expect(normalizePhone("+8613800138000")).toBe(canonical);
    expect(normalizePhone("8613800138000")).toBe(canonical);
    expect(normalizePhone("+86 138-0013-8000")).toBe(canonical);
    expect(normalizePhone("  (138) 0013 8000  ")).toBe(canonical);
    // 幂等：已规范形再归一次不变（回调/存储两处都会经过它）
    expect(normalizePhone(canonical)).toBe(canonical);
  });

  it("非法输入一律 null，且与合法近邻成对断言", () => {
    expect(normalizePhone("12800138000")).toBeNull(); // 第二位 2 不在 [3-9]
    expect(normalizePhone("1380013800")).toBeNull(); // 10 位
    expect(normalizePhone("138001380000")).toBeNull(); // 12 位
    expect(normalizePhone("+85291234567")).toBeNull(); // 非中国内地
    expect(normalizePhone("1380013800a")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    // 近邻：只差一位的合法号码必须成功，证明上面不是「什么都返回 null」
    expect(normalizePhone("13800138001")).toBe("+8613800138001");
  });
});

describe("isCanonicalPhone / toNationalNumber / maskPhone", () => {
  it("isCanonicalPhone 只认规范形（不做容错）", () => {
    expect(isCanonicalPhone("+8613800138000")).toBe(true);
    expect(isCanonicalPhone("13800138000")).toBe(false);
    expect(isCanonicalPhone("+8612800138000")).toBe(false);
  });

  it("toNationalNumber 去掉 +86 前缀", () => {
    expect(toNationalNumber("+8613800138000")).toBe("13800138000");
    expect(toNationalNumber("+8619912345678")).toBe("19912345678");
  });

  it("maskPhone 保留前 3 后 4，非法输入不漏原值", () => {
    expect(maskPhone("+8613800138000")).toBe("+86 138****8000");
    // 关键：打码函数对非法输入**不能**原样返回（那等于把明文号码写进日志）
    expect(maskPhone("13800138000")).toBe("***");
    expect(maskPhone("")).toBe("***");
  });
});

describe("parseSmsAllowlist", () => {
  it("空/缺失 = 全放行（判据是 raw.trim() 为空，不是「过滤后没条目」）", () => {
    for (const raw of [undefined, "", "   "]) {
      const list = parseSmsAllowlist(raw);
      expect(list.allowAll).toBe(true);
      expect(list.phones.size).toBe(0);
    }
    // 反例成对：只有逗号/空白的**非空串**不算「没配」—— 见下一条 deny-all 用例
    expect(parseSmsAllowlist(" , , ").allowAll).toBe(false);
  });

  it("有条目 ⇒ 只放行集合内（大小写/分隔符无关，归一后比对）", () => {
    const list = parseSmsAllowlist("13800138000, +86 139-0013-9000");
    expect(list.allowAll).toBe(false);
    expect(list.phones.size).toBe(2);
    expect(isPhoneAllowed(list, "+8613800138000")).toBe(true);
    expect(isPhoneAllowed(list, "+8613900139000")).toBe(true);
    expect(isPhoneAllowed(list, "+8613700137000")).toBe(false);
  });

  it("非空但全部非法 ⇒ 全拒（fail-closed，不静默退化成全放行）", () => {
    // 第二项是手滑形态：全是逗号/空白的非空串 —— 过滤后无条目，但**不是**「没配」
    for (const raw of ["abc, 123, +85291234567", " , , "]) {
      const list = parseSmsAllowlist(raw);
      expect(list.allowAll).toBe(false);
      expect(list.phones.size).toBe(0);
      // 这条是本用例的判别点：任何号码都被拒
      expect(isPhoneAllowed(list, "+8613800138000")).toBe(false);
    }
  });

  it("合法与非法混排时，非法项被丢弃而不污染合法项", () => {
    const list = parseSmsAllowlist("abc,13800138000");
    expect(list.allowAll).toBe(false);
    expect(list.phones.size).toBe(1);
    expect(isPhoneAllowed(list, "+8613800138000")).toBe(true);
  });
});

describe("isSmsAuthEnabled", () => {
  it("四种真值与大小写/空白", () => {
    for (const raw of ["true", "1", "yes", "on", "TRUE", " Yes ", "ON"]) {
      expect(isSmsAuthEnabled(raw)).toBe(true);
    }
  });

  it("其余一律关闭（含缺省）", () => {
    for (const raw of [undefined, "", "false", "0", "no", "off", "enabled", "2"]) {
      expect(isSmsAuthEnabled(raw)).toBe(false);
    }
  });
});

describe("renderTemplateParam", () => {
  const DEFAULT = '{"code":"##code##","min":"5"}';

  it("替换验证码并保留其余变量", () => {
    expect(JSON.parse(renderTemplateParam(DEFAULT, "123456"))).toEqual({
      code: "123456",
      min: "5",
    });
  });

  it("变量名可配（不写死 code）—— 控制台模板换了参数名只改 vars 不改代码", () => {
    expect(JSON.parse(renderTemplateParam('{"yzm":"##code##"}', "654321"))).toEqual({
      yzm: "654321",
    });
  });

  it("同一值里多处占位符全部替换", () => {
    expect(JSON.parse(renderTemplateParam('{"a":"##code##-##code##"}', "1"))).toEqual({
      a: "1-1",
    });
  });

  it("非字符串值原样保留（分钟数写成数字不该被判成配置错误）", () => {
    expect(JSON.parse(renderTemplateParam('{"code":"##code##","min":5}', "1"))).toEqual({
      code: "1",
      min: 5,
    });
  });

  it("非法 JSON ⇒ SmsTemplateError(SMS_TEMPLATE_INVALID)", () => {
    expect(() => renderTemplateParam("{not json", "1")).toThrow(SmsTemplateError);
    try {
      renderTemplateParam("{not json", "1");
    } catch (err) {
      expect((err as SmsTemplateError).code).toBe("SMS_TEMPLATE_INVALID");
    }
  });

  it("顶层非对象（数组/标量）⇒ 抛", () => {
    expect(() => renderTemplateParam('["##code##"]', "1")).toThrow(SmsTemplateError);
    expect(() => renderTemplateParam('"##code##"', "1")).toThrow(SmsTemplateError);
    expect(() => renderTemplateParam("null", "1")).toThrow(SmsTemplateError);
  });

  it("缺少 ##code## 占位符 ⇒ 抛（否则短信照发、正文无码，而服务端以为成功）", () => {
    expect(() => renderTemplateParam('{"code":"###","min":"5"}', "1")).toThrow(SmsTemplateError);
  });
});

describe("classifyLoginIdentifier（登录页单一输入框分流）", () => {
  it("含 @ ⇒ 邮箱", () => {
    expect(classifyLoginIdentifier("user@example.com")).toEqual({
      kind: "email",
      email: "user@example.com",
    });
    // 前后空白被 trim
    expect(classifyLoginIdentifier("  user@example.com ")).toEqual({
      kind: "email",
      email: "user@example.com",
    });
  });

  it("手机号三种写法都归一到规范形", () => {
    for (const raw of ["13800138000", "+8613800138000", "+86 138-0013-8000"]) {
      expect(classifyLoginIdentifier(raw)).toEqual({
        kind: "phone",
        phoneNumber: "+8613800138000",
      });
    }
  });

  it("非中国区号码 ⇒ invalid（PRD 范围限制：仅 +86）", () => {
    expect(classifyLoginIdentifier("+85291234567")).toEqual({ kind: "invalid" });
    expect(classifyLoginIdentifier("+14155552671")).toEqual({ kind: "invalid" });
  });

  it("空串与无 @ 的非号码 ⇒ invalid", () => {
    expect(classifyLoginIdentifier("")).toEqual({ kind: "invalid" });
    expect(classifyLoginIdentifier("   ")).toEqual({ kind: "invalid" });
    expect(classifyLoginIdentifier("admin")).toEqual({ kind: "invalid" });
    expect(classifyLoginIdentifier("1380013800")).toEqual({ kind: "invalid" });
  });
});

// 11-08 R10 / design §14.3：解绑邮箱后的重置地址与手机号注册共用同一生成函数。
describe("buildPhonePlaceholderEmail（占位邮箱生成，单一真源）", () => {
  it("命中 isPlaceholderEmail，且号码后 11 位原样带入", () => {
    const email = buildPhonePlaceholderEmail("+8613800138000");
    // 与识别判据成对断言：生成器与识别器漂移会以「未绑定邮箱」显示错乱的形式出现
    expect(isPlaceholderEmail(email)).toBe(true);
    expect(email.endsWith("+8613800138000@phone.invalid")).toBe(true);
    expect(email).toMatch(/^u[0-9a-f]{5}\.\+8613800138000@phone\.invalid$/);
  });

  it("两次调用随机段不同（防同一号码重复注册撞 users.email UNIQUE）", () => {
    const first = buildPhonePlaceholderEmail("+8613800138000");
    const second = buildPhonePlaceholderEmail("+8613800138000");
    // 随机段 = `u` 后 5 位十六进制；号码段相同，前缀必须不同
    expect(first.slice(0, 6)).not.toBe(second.slice(0, 6));
    expect(first).not.toBe(second);
  });

  it("不同号码生成不同地址（号码段是判据的一部分）", () => {
    const a = buildPhonePlaceholderEmail("+8613800138000");
    const b = buildPhonePlaceholderEmail("+8613900139000");
    expect(a.endsWith("+8613800138000@phone.invalid")).toBe(true);
    expect(b.endsWith("+8613900139000@phone.invalid")).toBe(true);
  });
});
