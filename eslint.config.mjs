import eslint from '@eslint/js'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['.tooling/**', 'node_modules/**', 'out/**', 'release/**', 'test-results/**', 'playwright-report/**']
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser
      }
    },
    rules: {
      'vue/multi-word-component-names': 'off'
    }
  },
  {
    files: [
      'electron.vite.config.ts',
      'scripts/**/*.mjs',
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'tests/**/*.ts'
    ],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ['src/renderer/src/**/*.{ts,vue}'],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    files: ['scripts/verify-packaged-macos.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
  }
)
