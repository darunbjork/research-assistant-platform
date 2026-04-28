import typescriptParser from '@typescript-eslint/parser';
import typescriptPlugin from '@typescript-eslint/eslint-plugin';
import prettierPlugin from 'eslint-plugin-prettier';

export default [
  {
    // Specify the files that should be processed by this configuration
    files: ['**/*.ts'],
    // Define language options, including the parser and project configuration
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        project: './tsconfig.json', // Path to the tsconfig.json file
        sourceType: 'module', // Use ES module syntax
      },
    },
    // Load plugins
    plugins: {
      '@typescript-eslint': typescriptPlugin,
      prettier: prettierPlugin,
    },
    // Define rules
    rules: {
      // TypeScript-specific rules
      '@typescript-eslint/no-explicit-any': 'warn', // Warn about 'any' types, adjust as needed
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }], // Warn about unused variables, ignore those starting with '_'

      // General JavaScript/TypeScript rules
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }], // Fallback for potential JS files, though mainly for TS
      'no-console': process.env.NODE_ENV === 'production' ? 'error' : 'warn', // Error on console in production, warn otherwise
      'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'warn', // Error on debugger in production, warn otherwise

      // Prettier rules: integrate Prettier checks into ESLint
      // This rule will run Prettier and report any formatting differences as ESLint errors
      'prettier/prettier': 'warn', // Use 'warn' to show formatting issues as warnings, 'error' to make them fail the lint
    },
    // Specify files to ignore
    ignores: ['node_modules', 'dist'],
  },
  // Add configurations for other file types if needed
  {
    files: ['**/*.js'],
    ignores: ['node_modules', 'dist'],
  },
  {
    files: ['**/*.json'],
    ignores: ['node_modules', 'dist'],
  },
];