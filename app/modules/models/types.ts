// 价格表模块类型：复用后端 Zod schema 推导（spec type-safety.md）。
import type {
  ModelResponse,
  CreateModelInput,
  UpdateModelInput,
  SyncOpenrouterOutput,
} from "../../../src/routes/models/types";

export type { ModelResponse, CreateModelInput, UpdateModelInput, SyncOpenrouterOutput };

export interface ListModelsOutput {
  success: true;
  items: ModelResponse[];
  total: number;
}
