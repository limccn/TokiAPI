import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { UserResponse } from "../types";

/** 可解绑的登录标识（11-08 R10）：GitHub OAuth 行 / 邮箱凭据行。 */
export type UserIdentityKind = "github" | "email";

/**
 * DELETE /api/users/:id/{github|email} — 解绑目标用户的登录方式（admin，11-08 R10）。
 *
 * 两个端点同形（404 / 409 护栏 / `{ success, user }`），故合成一个 mutation：
 * 调用方先确认，成功后 invalidate 列表 —— 服务端返回的 user 只用于结束态展示，
 * 列表里的 phoneNumber / githubLinked / emailRegistered 一律以重新拉取为准。
 */
export function useUnbindUserIdentity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: UserIdentityKind }) =>
      apiFetch<{ success: true; user: UserResponse }>(`/api/users/${id}/${kind}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}
