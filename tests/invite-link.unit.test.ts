// 批次 U（D28/D29）：邀请链接构建与归一（app/lib/invite-link.ts 纯函数）。
// ⚠ 测试侧**无 `@/` 别名**（vitest.config 无 resolve.alias，tsconfig.test 的 paths 继承不到）——
//   一律相对导入（批次 Q 教训）。
import { describe, expect, it } from "vitest";
import { buildInviteLink, normalizeInviteCode, toInviteCode } from "../app/lib/invite-link";

describe("normalizeInviteCode（与服务端 validateInviteCode 同口径）", () => {
  it("trim + 大写", () => {
    expect(normalizeInviteCode("  abc123defg  ")).toBe("ABC123DEFG");
    expect(normalizeInviteCode("AbC123Defg")).toBe("ABC123DEFG");
  });

  it("空 / 纯空白 → 空串（预填与校验的「无码」分支靠它）", () => {
    expect(normalizeInviteCode("")).toBe("");
    expect(normalizeInviteCode("   \t ")).toBe("");
  });

  it("已是归一形态则恒等（预填不改动正确输入）", () => {
    expect(normalizeInviteCode("ABC123DEFG")).toBe("ABC123DEFG");
  });
});

describe("toInviteCode（邀请码输入框清洗：字母数字、≤10 位）", () => {
  it("去掉空格/连字符等非字母数字（粘贴带分隔符的码）", () => {
    expect(toInviteCode("ab cd-efgh ijklm")).toBe("abcdefghij");
  });

  it("截到 10 位（generateInviteCode 缺省长度）", () => {
    expect(toInviteCode("ABCDEFGHJKMNP")).toBe("ABCDEFGHJK");
  });

  it("大小写不归一（归一仍是 normalizeInviteCode 的职责，输入态不改写用户键入）", () => {
    expect(toInviteCode("AbC123Defg")).toBe("AbC123Defg");
  });

  it("已是合法码则恒等", () => {
    expect(toInviteCode("ABC123DEFG")).toBe("ABC123DEFG");
  });
});

describe("buildInviteLink（AC48 判据：剪贴板字符串本身）", () => {
  it("{origin}/register?invite={CODE}，码与行内展示逐字一致", () => {
    expect(buildInviteLink("ABC123DEFG", "https://platform.lmlh.net")).toBe(
      "https://platform.lmlh.net/register?invite=ABC123DEFG",
    );
    expect(buildInviteLink("ABC123DEFG", "http://localhost:5173")).toBe(
      "http://localhost:5173/register?invite=ABC123DEFG",
    );
  });

  it("build **不归一**（复制什么就是什么 —— AC48 要求与展示码逐字一致）", () => {
    // 归一是读取侧（注册页预填）的职责；这里若悄悄大写化，展示码将来一旦含小写
    // 就会与剪贴板不一致。
    expect(buildInviteLink("abc123", "https://x.test")).toBe(
      "https://x.test/register?invite=abc123",
    );
  });

  it("码含保留字符时编码（防链接被截断/歧义）", () => {
    expect(buildInviteLink("A&B=C", "https://x.test")).toBe(
      "https://x.test/register?invite=A%26B%3DC",
    );
  });
});
