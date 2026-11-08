// 手机号/验证码输入框清洗纯函数（app/lib/phone-input.ts，11-07 输入格式统一）。
//
// 判别性纪律（spec shared/assertion-discipline）：每个 negative 用例都给出**能通过的近邻**
// 一起断言，避免「函数恒返回空串」也能全绿。
// ⚠ 测试侧**无 `@/` 别名**（vitest.config 无 resolve.alias）—— 一律相对导入。
import { describe, expect, it } from "vitest";
import {
  NATIONAL_PHONE_LENGTH,
  PHONE_COUNTRY_CODE,
  SMS_CODE_LENGTH,
  composePhoneNumber,
  toNationalDigits,
  toSmsCode,
} from "../app/lib/phone-input";

describe("toNationalDigits（只留数字、剥国家码、截 11 位）", () => {
  it("合法 11 位恒等", () => {
    expect(toNationalDigits("13800138000")).toBe("13800138000");
  });

  it("字母/空格/连字符被清掉（不吞相邻数字）", () => {
    expect(toNationalDigits("138 0013 8000")).toBe("13800138000");
    expect(toNationalDigits("abc13800138000xyz")).toBe("13800138000");
  });

  it("粘贴完整号码时剥掉 86 国家码", () => {
    expect(toNationalDigits("+86 138 0013 8000")).toBe("13800138000");
    expect(toNationalDigits("8613800138000")).toBe("13800138000");
  });

  it("不超过 11 位：第 12 位起被丢弃", () => {
    expect(toNationalDigits("138001380009")).toBe("13800138000");
  });

  it("未输完不补齐（输入态只清洗，合法性归 composePhoneNumber）", () => {
    expect(toNationalDigits("138")).toBe("138");
    expect(toNationalDigits("")).toBe("");
  });

  it("以 1 开头的 12 位数字不误剥（86 只在超长且以 86 开头时才可能是国家码）", () => {
    expect(toNationalDigits("168001380001")).toBe("16800138000");
  });

  it("常量与服务端格式一致", () => {
    expect(NATIONAL_PHONE_LENGTH).toBe(11);
    expect(PHONE_COUNTRY_CODE).toBe("+86");
    expect(SMS_CODE_LENGTH).toBe(6);
  });
});

describe("toSmsCode（只留数字、截 6 位）", () => {
  it("合法 6 位恒等", () => {
    expect(toSmsCode("123456")).toBe("123456");
  });

  it("字母被清掉，数字保留", () => {
    expect(toSmsCode("12ab3456")).toBe("123456");
  });

  it("带空格粘贴不丢位数（maxLength 会在清洗前截断，故输入框不再设 maxLength）", () => {
    expect(toSmsCode("123 456")).toBe("123456");
  });

  it("第 7 位起被丢弃", () => {
    expect(toSmsCode("1234567")).toBe("123456");
  });

  it("纯字母 → 空串（近邻为上面的数字用例）", () => {
    expect(toSmsCode("abcdef")).toBe("");
  });
});

describe("composePhoneNumber（输入态 → 规范形）", () => {
  it("11 位合法号码拼成 +86 规范形", () => {
    expect(composePhoneNumber("13800138000")).toBe("+8613800138000");
  });

  it("位数不足 / 号段非法 / 空串 → null", () => {
    expect(composePhoneNumber("1380013800")).toBeNull();
    expect(composePhoneNumber("12800138000")).toBeNull();
    expect(composePhoneNumber("")).toBeNull();
  });
});
