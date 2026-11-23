import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type {
  CreateInviteInput,
  CreateInviteResult,
  InviteTokenResult,
  ListInvitesResult,
} from "../types";

/** GET /api/tokimeki/invites — 本人 invite（不含 URL）。 */
export function useTokimekiInvites(enabled = true) {
  return useQuery({
    queryKey: ["tokimeki", "invites"],
    queryFn: () => apiFetch<ListInvitesResult>("/api/tokimeki/invites"),
    enabled,
    staleTime: 15_000,
  });
}

/** POST /api/tokimeki/invites — 创建 invite（响应含一次性 URL）。 */
export function useCreateTokimekiInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInviteInput) =>
      apiFetch<CreateInviteResult>("/api/tokimeki/invites", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tokimeki", "invites"] });
    },
  });
}

/** DELETE /api/tokimeki/invites/:id — 撤销（幂等）。 */
export function useRevokeTokimekiInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ success: true }>(`/api/tokimeki/invites/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tokimeki", "invites"] });
    },
  });
}

/** POST /api/tokimeki/invites/:id/token — 重新生成 CLI Session JWT。 */
export function useTokimekiInviteToken() {
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<InviteTokenResult>(`/api/tokimeki/invites/${id}/token`, { method: "POST" }),
  });
}

/** GET /api/tokimeki/namespace — 5 位 namespace_short（懒回填）。 */
export function useTokimekiNamespace(enabled = true) {
  return useQuery({
    queryKey: ["tokimeki", "namespace"],
    queryFn: () => apiFetch<{ success: true; namespace: string }>("/api/tokimeki/namespace"),
    enabled,
    staleTime: 60_000,
  });
}
