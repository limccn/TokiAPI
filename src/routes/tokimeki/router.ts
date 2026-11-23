// Tokimeki master token 管理路由（11-18-tokimeki-master-token）：/api/tokimeki/*。
// JWKS 由 src/index.ts 在 requireSession 之前单独挂载；本 router 只含会话端点。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { createTokimekiTokenRoute } from "./procedures/create";
import { createInviteRoute } from "./procedures/create-invite";
import { inviteTokenRoute } from "./procedures/invite-token";
import { listInvitesRoute } from "./procedures/list-invites";
import { listTokimekiTokensRoute } from "./procedures/list";
import { namespaceRoute } from "./procedures/namespace";
import { revokeInviteRoute } from "./procedures/revoke-invite";

const app = new Hono<AppEnv>();

createTokimekiTokenRoute(app); // POST /token
listTokimekiTokensRoute(app); // GET /tokens
namespaceRoute(app); // GET /namespace
createInviteRoute(app); // POST /invites
listInvitesRoute(app); // GET /invites
revokeInviteRoute(app); // DELETE /invites/:id
inviteTokenRoute(app); // POST /invites/:id/token

export default app;
