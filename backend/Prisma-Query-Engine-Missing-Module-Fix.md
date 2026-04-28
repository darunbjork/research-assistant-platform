**Issue:** The error `Cannot find module ... query_engine_bg.postgresql.wasm-base64.js` occurs when the Prisma CLI version and `@prisma/client` version are mismatched, or when the Prisma engine files are missing/corrupted after installation.

---

### Fix in 3 steps

1.  **Align versions** – Ensure `prisma` and `@prisma/client` have the *exact same version* in `package.json`, then run `npm install`.  
    ```bash
    npm install prisma@6.19.3 @prisma/client@6.19.3
    ```

2.  **Regenerate the client** – Run `npx prisma generate` to download the correct engine files.  
    ```bash
    npx prisma generate
    ```

3.  **If still broken, clean full reinstall** – Delete `node_modules`, `package-lock.json`, and the Prisma cache, then reinstall.  
    ```bash
    rm -rf node_modules package-lock.json
    npm install
    npx prisma generate
    ```

> **Pro tip:** Always keep `prisma` and `@prisma/client` on the *same major version* (e.g., both `6.x.x` or both `7.x.x`). Use `npm list prisma @prisma/client` to verify.