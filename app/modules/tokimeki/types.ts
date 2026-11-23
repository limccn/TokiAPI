// Tokimeki 模块类型：复用后端 Zod 推导（spec type-safety.md：禁止前端重定义）。
import type {
  AttachInput,
  CreateInviteInput,
  CreateTokimekiTokenInput,
  CreateTokimekiTokenOutput,
  InviteSummaryOutput,
  ListTokimekiTokensOutput,
  TokimekiTokenRecord,
} from "../../../src/routes/tokimeki/types";

export type {
  AttachInput,
  CreateInviteInput,
  CreateTokimekiTokenInput,
  CreateTokimekiTokenOutput,
  InviteSummaryOutput,
  ListTokimekiTokensOutput,
  TokimekiTokenRecord,
};

export type InviteMode = "viewer" | "listener";

export interface CreatedInvite extends InviteSummaryOutput {
  /** One-time share URL; never stored by the server. */
  url: string;
}

export interface CreateInviteResult {
  success: true;
  invite: CreatedInvite;
}

export interface ListInvitesResult {
  success: true;
  items: InviteSummaryOutput[];
}

export interface InviteTokenResult {
  success: true;
  token: string;
  session: string;
  mode: InviteMode;
  allowWeb: boolean;
  passcodeRequired: boolean;
  expiresAt: string;
}
