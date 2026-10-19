import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { SyncOpenrouterOutput } from "../types";

/**
 * POST /api/models/sync-openrouter — OpenRouter 价格同步（admin）。
 *
 * 语义（design §4.1）：服务端拉 OR 公开目录 → 匹配行刷 5 价列 + 白名单缺行 INSERT → 回显
 * synced / inserted / skipped 明细。无 body；幂等可重放。member 调用 403（按钮本就
 * 只对 admin 渲染，这里是第二道防线）。
 */
export function useSyncOpenrouter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiFetch<SyncOpenrouterOutput>("/api/models/sync-openrouter", {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}