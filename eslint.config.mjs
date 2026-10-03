import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "coverage/**", "playwright-report/**", "test-results/**"] },
  {
    files: ["**/*.ts"],
    plugins: { "@typescript-eslint": tseslint },
    languageOptions: { parser: tsParser, globals: { ...globals.browser, ...globals.node } },
    rules: {
      "no-debugger": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];
