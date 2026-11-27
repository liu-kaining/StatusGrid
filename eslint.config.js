import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.statusgrid/**'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  { files: ['workers/**/*.js'], languageOptions: {
    globals: { fetch: 'readonly', AbortSignal: 'readonly', console: 'readonly' },
  } },
);
