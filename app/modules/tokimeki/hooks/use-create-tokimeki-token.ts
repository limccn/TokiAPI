import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { CreateTokimekiTokenInput, CreateTokimekiTokenOutput } from "../types";

/** POST /api/tokimeki/token — 签发 Host JWT（响应含一次性明文）。 */
export function useCreateTokimekiToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTokimekiTokenInput) =>
      apiFetch<CreateTokimekiTokenOutput>("/api/tokimeki/token", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tokimeki", "tokens"] });
    },
  });
}
