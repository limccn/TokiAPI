// 命名空间生成单测（11-18-tokimeki-master-token）：字符集/长度/前缀关系。
import { describe, expect, it } from "vitest";
import {
  NAMESPACE_CHARSET,
  NAMESPACE_SHORT_LENGTH,
  generateNamespaceId,
  generateNamespaceShort,
  isNamespaceShort,
} from "../src/lib/namespace";

describe("namespace 生成", () => {
  it("短 id 为 5 位且只使用约定字符集", () => {
    for (let index = 0; index < 50; index += 1) {
      const short = generateNamespaceShort();
      expect(short).toHaveLength(NAMESPACE_SHORT_LENGTH);
      for (const char of short) {
        expect(NAMESPACE_CHARSET).toContain(char);
      }
      expect(short).not.toMatch(/[014ilo]/u);
    }
  });

  it("完整 id = 短 id + 11 位后缀（前 5 位恒等于短 id）", () => {
    const short = generateNamespaceShort();
    const id = generateNamespaceId(short);
    expect(id).toHaveLength(16);
    expect(id.startsWith(short)).toBe(true);
    expect(id.slice(0, NAMESPACE_SHORT_LENGTH)).toBe(short);
  });

  it("isNamespaceShort 校验长度与字符集", () => {
    expect(isNamespaceShort("abcde")).toBe(true);
    const valid = generateNamespaceShort();
    expect(isNamespaceShort(valid)).toBe(true);
    expect(isNamespaceShort("abc")).toBe(false);
    expect(isNamespaceShort("abcdef")).toBe(false);
    expect(isNamespaceShort("abc0e")).toBe(false); // 0 不在字符集
    expect(isNamespaceShort("abc4e")).toBe(false); // 4 被显式排除
  });

  it("两次生成互不相同（概率性护栏）", () => {
    const samples = new Set(
      Array.from({ length: 20 }, () => generateNamespaceShort()),
    );
    expect(samples.size).toBeGreaterThan(1);
  });
});
