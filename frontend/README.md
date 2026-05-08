This commit downgrades Tailwind CSS from v4 to v3 and resolves compatibility issues.

The project was experiencing errors due to Tailwind CSS v4 installation, which has different syntax and PostCSS plugin requirements compared to v3. This change reverts to v3 to match the project's intended setup and tutorial.

**Changes:**
1.  Uninstalled v4 packages (`tailwindcss`, `@tailwindcss/postcss`).
2.  Installed v3 compatible packages (`tailwindcss@^3`, `postcss`, `autoprefixer`).
3.  Restored `frontend/postcss.config.cjs` to the v3-compatible configuration.
4.  Updated `frontend/src/index.css` with the correct v3 `@tailwind` directives.
5.  The `frontend/tailwind.config.js` file remains unchanged as it is compatible with v3.

After applying these changes, restarting the development server (`npm run dev`) should resolve the PostCSS and Tailwind CSS related errors.