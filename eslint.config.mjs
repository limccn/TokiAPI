// ESLint 9/10 flat config（M8 8.2 质量门）。
// 范围：仅覆盖 src/ + app/ + tests/（spec quality.md 强制：无 any、无非空断言 !、无 console.log）。
// 不在范围：scripts/*.mjs（CLI 验证脚本，console.log 合法）、构建/配置脚本（*.config.*）、
// 生成物（dist/、drizzle/、worker-configuration.d.ts）、文档/数据文件。
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "drizzle/**",
      "scripts/**",
      "*.config.*",
      "worker-configuration.d.ts",
      "wrangler.jsonc",
      "seed.sql",
      "package-lock.json",
    ],
  },
  {
    files: ["src/**/*.ts", "app/**/*.{ts,tsx}", "tests/**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-console": "error",
      // 与 tsconfig noUnusedParameters 一致：以下划线开头的参数视为有意忽略
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
