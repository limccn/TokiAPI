import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ListTokimekiTokensOutput } from "../types";

/** GET /api/tokimeki/tokens — 本人已签发的 master token 元数据。 */
export function useTokimekiTokens(enabled = true) {
  return useQuery({
    queryKey: ["tokimeki", "tokens"],
    queryFn: () => apiFetch<ListTokimekiTokensOutput>("/api/tokimeki/tokens"),
    enabled,
    staleTime: 30_000,
  });
}
