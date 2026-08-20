import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist-main", "dist-renderer", "release", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": hooks },
    rules: hooks.configs.flat.recommended.rules,
  },
  {
    files: ["main/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
);
