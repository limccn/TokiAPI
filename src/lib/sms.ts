// 阿里云「短信认证」(dypnsapi) 发送通道（11-06-sms-alicloud-auth；design §4.3）。
//
// 形态刻意对齐 src/lib/email.ts：裸 fetch、无 SDK、失败**抛错**（后果由调用点决定）。
// 两处不同：
//   1. 这里多了「开关 / 白名单 / 配置」三道**静默跳过**的门（邮件只有两道）；
//   2. 成功判据不是 HTTP 状态码 —— 阿里云的失败响应**同样返回 HTTP 200**
//      （实测：`{"Code":"ILLEGAL_MOBILE","Success":false}`），只看 `response.ok` 会把
//      「号码非法 / 频控 / 未开通」全部当成发送成功（research R14）。
//
// 三种静默、一种抛错，分界是「部署方是否需要在第一次请求时就发现」：
//   静默 = 通道没开/没配/白名单外（合法的中间态或**刻意**行为，正常运维可接受）；
//   抛错 = 签名、模板、号码形态、上游拒绝（都是配置或环境错误，静默会让「验证码永远发不出、
//          端点却一直 200」变成无法诊断的黑洞 —— 与 email.ts 的 fail-loud 同一条理由）。
//
// 🔴 验证码**绝不入日志**（spec backend/security：Never log raw tokens）；号码一律打码。
import type { Logger } from "./logger";
import {
  isCanonicalPhone,
  isPhoneAllowed,
  isSmsAuthEnabled,
  maskPhone,
  parseSmsAllowlist,
  renderTemplateParam,
  SmsTemplateError,
  toNationalNumber,
} from "./phone";
import { signRpcRequest } from "./aliyun-acs3";

/** 阿里云「短信认证」服务域名（与短信服务 dysmsapi.aliyuncs.com 不是同一个）。 */
export const SMS_API_HOST = "dypnsapi.aliyuncs.com";
export const SMS_API_VERSION = "2017-05-25";
/** 出站超时上界：信号同时约束响应体读取，防上游挂起拖死认证请求。 */
export const SMS_TIMEOUT_MS = 10_000;
/**
 * `SMS_TEMPLATE_PARAM` 的缺省值 —— 必须与 wrangler.jsonc 的同名 vars 一致。
 * 变量名以控制台实际模板为准（赠送模板是 `${code}` / `${min}`）。
 *
 * 阿里云「短信认证」的**五个赠送模板共用这两个变量**（2026-11-06 复核：Logto 的
 * Aliyun MAS 连接器对全部 UsageType 都发 `{code, min}`；官方文档示例亦同）。
 * 故换模板 CODE **不需要**改本表。
 */
export const DEFAULT_TEMPLATE_PARAM = '{"code":"##code##","min":"5"}';

/**
 * 阿里云「短信认证」的五个系统赠送模板（控制台「赠送模板配置」页，2026-11-06 调研）。
 *
 * **只是文案不同**（「您正在进行重置密码操作…」vs「登录验证…」），验证流程、变量、
 * 频控完全一致；用哪个 CODE 由部署方在 `SMS_TEMPLATE_CODE*` 里指定。
 */
export const ALIYUN_GIFT_TEMPLATES = {
  /** 登录 / 注册 / 通用 / MFA / 组织邀请 */
  login: "100001",
  /** 修改绑定手机号（换绑） */
  changePhone: "100002",
  /** 重置密码 */
  resetPassword: "100003",
  /** 绑定新手机号 */
  bindPhone: "100004",
  /** 验证（已绑定）手机号 */
  verifyPhone: "100005",
} as const;

/**
 * 发码用途 —— 决定用哪个模板 CODE。**只有两类**，因为服务端只分得清两类：
 * `sendOTP`（登录/注册/绑定共用一个回调）与 `sendPasswordResetOTP`（找回密码）。
 * 绑定/换绑虽然阿里云另有专门模板（100002/100004/100005），但库不在发码阶段暴露
 * 「这次是绑定」这一信息 —— 把 `SMS_TEMPLATE_CODE` 设成绑定模板即可整体切换。
 */
export type SmsPurpose = "login" | "reset";

/** 失败正文入日志的上界（字符）。 */
const ERROR_BODY_LIMIT = 200;

/**
 * 只读这七个键，故 env 收窄为结构类型（同 `MailEnv`）：单测可直接传
 * `{ SMS_ACCESS_KEY_ID: "x", … }` 覆盖分支，无需造整个 Env。
 */
export interface SmsEnv {
  SMS_AUTH_ENABLED?: string;
  SMS_ACCESS_KEY_ID?: string;
  SMS_ACCESS_KEY_SECRET?: string;
  SMS_SIGN_NAME?: string;
  SMS_TEMPLATE_CODE?: string;
  /** 找回密码专用模板 CODE（可选）：空 = 回落 `SMS_TEMPLATE_CODE`。建议 `100003`。 */
  SMS_TEMPLATE_CODE_RESET?: string;
  SMS_TEMPLATE_PARAM?: string;
  SMS_ALLOWED_PHONES?: string;
}

/**
 * 解析本次发送要用的模板 CODE。
 *
 * 回落而不是「空就报错」：只有一个模板的部署（最常见）零配置即可工作；
 * 两个都空时仍走下面第 4 道门的 `SMS_CONFIG_INVALID`（fail-loud）。
 */
export function resolveTemplateCode(env: SmsEnv, purpose: SmsPurpose): string {
  const base = env.SMS_TEMPLATE_CODE?.trim() ?? "";
  if (purpose !== "reset") {
    return base;
  }
  const reset = env.SMS_TEMPLATE_CODE_RESET?.trim() ?? "";
  return reset === "" ? base : reset;
}

/**
 * 短信发送失败。`code` 优先取阿里云的 `Code`（如 `ILLEGAL_MOBILE` / `biz.FREQUENCY`），
 * 本地配置错误则用本模块的 `SMS_CONFIG_INVALID` / `SMS_TEMPLATE_INVALID`。
 * 端点层把它翻成 5xx/4xx 时**不要**回传阿里云原文（可能含内部信息），只回统一文案。
 */
export class SmsError extends Error {
  readonly code: string;
  readonly requestId?: string;

  constructor(code: string, message: string, requestId?: string) {
    super(message);
    this.name = "SmsError";
    this.code = code;
    this.requestId = requestId;
  }
}

interface SendSmsVerifyCodeResponse {
  Code?: unknown;
  Message?: unknown;
  Success?: unknown;
  RequestId?: unknown;
  Model?: { RequestId?: unknown; BizId?: unknown };
}

/**
 * 发送一条验证码短信。`code` 由调用方生成（B 模式：本仓生成与校验，阿里云只负责投递，
 * research R4 —— A 模式把答案存在阿里云侧，而 reset-password 链路读不到它）。
 *
 * 分支顺序是契约（先本地门控、后网络），见 design §4.3 表。
 */
export async function sendSmsCode(
  env: SmsEnv,
  logger: Logger,
  input: { phoneNumber: string; code: string; purpose?: SmsPurpose },
): Promise<void> {
  const purpose: SmsPurpose = input.purpose ?? "login";
  const masked = maskPhone(input.phoneNumber);

  // 1) 开关关闭：插件本就不注册，正常不可达 —— 防御性分支
  if (!isSmsAuthEnabled(env.SMS_AUTH_ENABLED)) {
    logger.info("sms_disabled", { phone: masked });
    return;
  }

  // 2) AK 缺失 = 通道未配置（合法中间态：允许先开 UI 再配凭据）
  const accessKeyId = env.SMS_ACCESS_KEY_ID?.trim() ?? "";
  const accessKeySecret = env.SMS_ACCESS_KEY_SECRET?.trim() ?? "";
  if (accessKeyId === "" || accessKeySecret === "") {
    logger.info("sms_not_configured", { phone: masked });
    return;
  }

  // 3) 白名单外：**必须静默**（抛错会让「号码是否在白名单」变成可探测信号）
  if (!isPhoneAllowed(parseSmsAllowlist(env.SMS_ALLOWED_PHONES), input.phoneNumber)) {
    logger.info("sms_skipped_allowlist", { phone: masked });
    return;
  }

  // 4) 配置/输入错误：抛（静默会让部署方无从发现）
  if (!isCanonicalPhone(input.phoneNumber)) {
    logger.error("sms_config_invalid", { field: "phoneNumber", phone: masked });
    throw new SmsError("SMS_CONFIG_INVALID", "phoneNumber is not canonical");
  }
  const signName = env.SMS_SIGN_NAME?.trim() ?? "";
  // 找回密码用独立模板（若配置），否则回落主模板；两键皆空 ⇒ 报的是主键
  //（SMS_TEMPLATE_CODE_RESET 为空是**合法回落**，不是缺配置）
  const templateCode = resolveTemplateCode(env, purpose);
  if (signName === "" || templateCode === "") {
    const field = signName === "" ? "SMS_SIGN_NAME" : "SMS_TEMPLATE_CODE";
    logger.error("sms_config_invalid", { field });
    throw new SmsError("SMS_CONFIG_INVALID", `${field} is not configured`);
  }
  let templateParam: string;
  try {
    templateParam = renderTemplateParam(
      env.SMS_TEMPLATE_PARAM ?? DEFAULT_TEMPLATE_PARAM,
      input.code,
    );
  } catch (error) {
    if (error instanceof SmsTemplateError) {
      logger.error("sms_config_invalid", { field: "SMS_TEMPLATE_PARAM", reason: error.message });
      throw new SmsError(error.code, error.message);
    }
    throw error;
  }

  // 5) 网络：签名 + 出站
  let request: Awaited<ReturnType<typeof signRpcRequest>>;
  try {
    request = await signRpcRequest({
      host: SMS_API_HOST,
      action: "SendSmsVerifyCode",
      version: SMS_API_VERSION,
      params: {
        PhoneNumber: toNationalNumber(input.phoneNumber),
        SignName: signName,
        TemplateCode: templateCode,
        TemplateParam: templateParam,
        // 刻意不传：ReturnVerifyCode（会把答案回传）、CodeLength / ValidTime
        //（B 模式下不由阿里云生成，传了反而误导 —— research R10-1）
      },
      accessKeyId,
      accessKeySecret,
    });
  } catch (error) {
    logger.error("sms_send_failed", { phone: masked, reason: "signing", error: String(error) });
    throw new SmsError("SMS_SIGN_FAILED", `signing failed: ${String(error)}`);
  }

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: "",
      signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
    });
  } catch (error) {
    logger.error("sms_send_failed", { phone: masked, reason: "network", error: String(error) });
    throw new SmsError("SMS_SEND_FAILED", `network: ${String(error)}`);
  }

  const body = await readJson(response);

  // 6) 成败看 Success + Code，**不看 HTTP 状态**（阿里云失败也回 200）
  if (!response.ok || body === null || body.Success !== true || body.Code !== "OK") {
    const code = typeof body?.Code === "string" ? body.Code : `HTTP_${response.status}`;
    const message = typeof body?.Message === "string" ? body.Message : "unexpected response";
    const requestId = typeof body?.RequestId === "string" ? body.RequestId : undefined;
    logger.error("sms_send_failed", {
      phone: masked,
      status: response.status,
      code,
      requestId,
      reason: message.slice(0, ERROR_BODY_LIMIT),
    });
    throw new SmsError(code, message, requestId);
  }

  // 7) 成功
  const requestId = typeof body.Model?.RequestId === "string" ? body.Model.RequestId : undefined;
  const bizId = typeof body.Model?.BizId === "string" ? body.Model.BizId : undefined;
  // `template` 记的是**实际用的 CODE**：多模板部署里「用户收到的文案不对」首先查这一项
  //（模板 CODE 不是秘密，日志里可以明文）。
  logger.info("sms_code_sent", { phone: masked, template: templateCode, requestId, bizId });
}

/** 读 JSON：读失败/非对象返回 null（由调用方按失败分支处理，不在这里抛）。 */
async function readJson(response: Response): Promise<SendSmsVerifyCodeResponse | null> {
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as SendSmsVerifyCodeResponse;
  } catch {
    return null;
  }
}
