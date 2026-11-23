import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface AnonHostResult {
  success: true;
  token: string;
  namespace: string;
  session: string;
  inviteUrl: string;
  expiresAt: string;
}

/** POST /api/tokimeki/anon-host — 公开；一次返回匿名 Host JWT 与 invite URL。 */
export function useAnonHost() {
  return useMutation({
    mutationFn: () =>
      apiFetch<AnonHostResult>("/api/tokimeki/anon-host", {
        method: "POST",
        body: "{}",
      }),
  });
}
