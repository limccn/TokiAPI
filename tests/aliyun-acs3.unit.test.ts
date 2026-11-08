// 阿里云 ACS3-HMAC-SHA256 单测（11-06-sms-alicloud-auth；design §4.2）。
//
// 这是全任务唯一的 **Gate A**：签名模块错了的表现是「请求结构完全合法、服务端永远 403」，
// 而且与「AK 无效 / 权限不足」在症状上无法区分。因此这里不写「差不多对」的断言，
// 一律钉官方文档给出的四个期望值，逐字节相等。
//
// 官方测试向量（research R8）：
//   host   ecs.cn-shanghai.aliyuncs.com
//   action RunInstances / version 2014-05-26
//   date   2023-10-26T10:22:32Z / nonce 3156853299f313e23d1673dc12e1703d
//   query  ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai
import { describe, expect, it } from "vitest";
import {
  canonicalQueryString,
  percentEncode,
  signRpcRequest,
} from "../src/lib/aliyun-acs3";

const VECTOR = {
  host: "ecs.cn-shanghai.aliyuncs.com",
  action: "RunInstances",
  version: "2014-05-26",
  params: {
    ImageId: "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd",
    RegionId: "cn-shanghai",
  },
  accessKeyId: "YourAccessKeyId",
  accessKeySecret: "YourAccessKeySecret",
  date: new Date("2023-10-26T10:22:32Z"),
  nonce: "3156853299f313e23d1673dc12e1703d",
} as const;

describe("官方测试向量（四个期望值逐字节相等）", () => {
  it("SignedHeaders + HashedCanonicalRequest + Signature", async () => {
    const request = await signRpcRequest({ ...VECTOR, params: { ...VECTOR.params } });

    expect(request.signedHeaders).toBe(
      "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
    );
    expect(request.hashedCanonicalRequest).toBe(
      "7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259",
    );
    expect(request.signature).toBe(
      "06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0",
    );
    // HashedRequestPayload（空 body 的 SHA-256）也必须是这个常量
    expect(request.headers["x-acs-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("Authorization 头按官方格式拼装，且 sign 的四个组件一致", async () => {
    const request = await signRpcRequest({ ...VECTOR, params: { ...VECTOR.params } });
    expect(request.headers.authorization).toBe(
      `ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=${request.signedHeaders},Signature=${request.signature}`,
    );
  });

  it("canonical request 的确切形态（含 header 块与 SignedHeaders 之间的空行）", async () => {
    const request = await signRpcRequest({ ...VECTOR, params: { ...VECTOR.params } });
    expect(request.canonicalRequest).toBe(
      [
        "POST",
        "/",
        "ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai",
        "host:ecs.cn-shanghai.aliyuncs.com\n" +
          "x-acs-action:RunInstances\n" +
          "x-acs-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n" +
          "x-acs-date:2023-10-26T10:22:32Z\n" +
          "x-acs-signature-nonce:3156853299f313e23d1673dc12e1703d\n" +
          "x-acs-version:2014-05-26\n",
        "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
  });
});

describe("反例：Action/Version/Format 进 query ⇒ 与官方向量不符（research R13）", () => {
  // 这条用例钉的是**本任务实际踩过的坑**：官方 SDK 示例的写法会诱导人把
  // Action/Version/Format 一起塞进 query，哈希立刻变成另一个值，而服务端只回
  // SignatureDoesNotMatch。没有这条断言，将来「顺手补上 Action」会静默复发。
  it("把三个参数塞进 query 后 HashedCanonicalRequest ≠ 官方向量", async () => {
    const query = canonicalQueryString({
      Action: "RunInstances",
      Format: "JSON",
      ImageId: "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd",
      RegionId: "cn-shanghai",
      Version: "2014-05-26",
    });
    const canonicalRequest = [
      "POST",
      "/",
      query,
      "host:ecs.cn-shanghai.aliyuncs.com\n" +
        "x-acs-action:RunInstances\n" +
        "x-acs-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n" +
        "x-acs-date:2023-10-26T10:22:32Z\n" +
        "x-acs-signature-nonce:3156853299f313e23d1673dc12e1703d\n" +
        "x-acs-version:2014-05-26\n",
      "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ].join("\n");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalRequest),
    );
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).not.toBe("7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259");
  });

  it("signRpcRequest 不把 Action/Version/Format 写进 URL", async () => {
    const request = await signRpcRequest({ ...VECTOR, params: { ...VECTOR.params } });
    expect(request.url).not.toContain("Action=");
    expect(request.url).not.toContain("Version=");
    expect(request.url).not.toContain("Format=");
    expect(request.url).toBe(
      "https://ecs.cn-shanghai.aliyuncs.com/?ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai",
    );
  });
});

describe("percentEncode", () => {
  it("RFC3986 保留集不编码", () => {
    expect(percentEncode("AZaz09-_.~")).toBe("AZaz09-_.~");
  });

  it("空格 → %20，且 !'()* 全部转义", () => {
    expect(percentEncode("a b")).toBe("a%20b");
    expect(percentEncode("!")).toBe("%21");
    expect(percentEncode("'")).toBe("%27");
    expect(percentEncode("(")).toBe("%28");
    expect(percentEncode(")")).toBe("%29");
    expect(percentEncode("*")).toBe("%2A");
  });

  it("中文字符按 UTF-8 百分号编码（模板参数里可能带中文）", () => {
    expect(percentEncode("恒创")).toBe("%E6%81%92%E5%88%9B");
  });
});

describe("canonicalQueryString", () => {
  it("按 key 升序并以 & 连接", () => {
    expect(canonicalQueryString({ b: "2", a: "1", C: "3" })).toBe("C=3&a=1&b=2");
  });

  it("空对象 → 空串", () => {
    expect(canonicalQueryString({})).toBe("");
  });

  it("key 与 value 都编码", () => {
    expect(canonicalQueryString({ TemplateParam: '{"code":"1"}' })).toBe(
      "TemplateParam=%7B%22code%22%3A%221%22%7D",
    );
  });
});

describe("signRpcRequest 的 header 契约", () => {
  it("set 里不含 host（fetch 禁用），但签名集里有", async () => {
    const request = await signRpcRequest({ ...VECTOR, params: { ...VECTOR.params } });
    expect(request.headers).not.toHaveProperty("host");
    expect(request.signedHeaders.split(";")).toContain("host");
  });

  it("accept 存在但不入签名（改它不影响 signature）", async () => {
    const request = await signRpcRequest({ ...VECTOR, params: { ...VECTOR.params } });
    expect(request.headers.accept).toBe("application/json");
    expect(request.signedHeaders).not.toContain("accept");
  });

  it("缺省 nonce 为 32 位小写 hex，且两次调用不同", async () => {
    const a = await signRpcRequest({ ...VECTOR, params: { ...VECTOR.params }, nonce: undefined });
    const b = await signRpcRequest({ ...VECTOR, params: { ...VECTOR.params }, nonce: undefined });
    expect(a.headers["x-acs-signature-nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(a.headers["x-acs-signature-nonce"]).not.toBe(b.headers["x-acs-signature-nonce"]);
  });

  it("x-acs-date 为秒级 ISO8601（无毫秒）", async () => {
    const request = await signRpcRequest({
      ...VECTOR,
      params: { ...VECTOR.params },
      date: new Date("2026-11-06T01:02:03.456Z"),
    });
    expect(request.headers["x-acs-date"]).toBe("2026-11-06T01:02:03Z");
  });
});
