const js = require("@eslint/js");

module.exports = [
  {
    ignores: [
      "**/dist/**",
      ".claude/**",
      "apps/**/*.ts",
      "apps/**/*.tsx",
      "node_modules/**",
      "packages/**/*.d.ts",
      "packages/**/*.js",
      "packages/**/*.js.map",
      "packages/**/*.ts",
      "scripts/**",
      "ui-tui/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        module: "readonly",
        require: "readonly"
      }
    }
  }
];
