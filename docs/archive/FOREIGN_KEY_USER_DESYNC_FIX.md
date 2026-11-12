# Foreign Key User Desync Fix

## Core Issue
During document ingestion, the pipeline failed with:
`Foreign key constraint violated on the constraint: documents_userId_fkey`

This occurred because:
1. **Database Reset**: The local database was reset to apply the `vector(3072)` migrations, which wiped the `users` table and deleted all existing user accounts.
2. **Stale Session JWT**: The frontend/client was still authenticated using a previously signed JWT access token in local storage or cookies.
3. **Weak Authentication Middleware**: The backend `authMiddleware` was only decoding the JWT and verifying its signature. Since the `JWT_SECRET` was unchanged, the signature remained valid. The middleware did not verify that the user actually existed in the database, passing through a non-existent `userId` which then violated foreign key constraints on the `documents` table.

## Fix Applied
1. **User Verification in Middleware**: Updated `authMiddleware` in `src/middleware/auth.middleware.ts` to perform a database check:
   ```typescript
   const user = await prisma.user.findUnique({
     where: { id: payload.userId },
     select: { id: true },
   })
   ```
   If the user does not exist in the database, it calls `next(new UnauthorizedError(...))` to return a `401 Unauthorized` response to the client. This triggers the client to log out and prompts the user to register or sign in again, resolving the stale token state immediately.
2. **User Experience**: The user will now be redirected to the login/register screen automatically if their database account is deleted or reset, instead of experiencing pipeline database errors.
