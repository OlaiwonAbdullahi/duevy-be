import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { createHash } from "crypto";
import { type User, type SpaceMembership, type SpaceRep } from "@prisma/client";
import { db } from "../config/db";
import { env } from "../config/env";
import { validate } from "../middleware/validate";
import { authenticate, type AuthenticatedRequest } from "../middleware/auth";
import { ok, fail, errors } from "../lib/response";
import { generateId } from "../lib/id";
import {
  createTokens,
  sendVerification,
  sendPasswordReset,
} from "../services/auth.service";
import { verifyGoogleIdToken } from "../lib/googleAuth";
import { verifyRefreshToken } from "../lib/jwt";
import { parseExpiryMs } from "../lib/jwt";
import { authLimiter } from "../middleware/rateLimiter";

export const authRouter = Router();

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie("refreshToken", token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE as "lax" | "strict" | "none",
    maxAge: parseExpiryMs(env.JWT_REFRESH_EXPIRES_IN),
    path: "/v1/auth/refresh", // restrict to refresh endpoint
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie("refreshToken", { path: "/v1/auth/refresh" });
}

// Shared by /auth/register and /auth/google — the department-setup fields
// collected when the signer picks the `rep` role (§2.1/§2.3).
const spaceDraftSchema = z.object({
  name: z.string(),
  short: z.string().min(2).max(6),
  kind: z.enum(["department", "association", "faculty", "club"]),
  school: z.string(),
  faculty: z.string().optional(),
  theme: z
    .enum(["emerald", "ocean", "royal", "crimson", "tangerine"])
    .default("emerald"),
  coRepInvites: z.array(z.string().email()).optional(),
});

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------
const registerSchema = z
  .object({
    name: z.string().min(2).max(100),
    matricNo: z.string().min(1),
    email: z
      .string()
      .email()
      .transform((e) => e.toLowerCase()),
    password: z.string().min(8),
    acceptedTerms: z.literal(true),
    role: z.enum(["student", "rep"]).default("student"),
    referralCode: z.string().optional(),
    space: spaceDraftSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.role === "rep" && !data.space) return false;
      return true;
    },
    { message: "space is required when role is rep", path: ["space"] },
  );

authRouter.post(
  "/register",
  authLimiter,
  validate(registerSchema),
  async (req: Request, res: Response): Promise<void> => {
    const data = req.body as z.infer<typeof registerSchema>;

    const existing = await db.user.findUnique({ where: { email: data.email } });
    if (existing) {
      fail(res, 409, "VALIDATION_ERROR", "Email already in use", [
        { field: "email", issue: "already in use" },
      ]);
      return;
    }

    const passwordHash = await bcrypt.hash(data.password, env.BCRYPT_ROUNDS);

    // Begin transaction to create user and potentially rep application
    const user = await db.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          id: generateId("user"),
          name: data.name,
          email: data.email,
          matricNo: data.matricNo,
          passwordHash,
          role: "student", // Everyone starts as a student; reps are provisioned on admin approval
          repApplicationStatus: data.role === "rep" ? "pending" : "none",
          termsAcceptedAt: new Date(),
          termsVersion: "1.0.0",
        },
      });

      if (data.role === "rep" && data.space) {
        await tx.repApplication.create({
          data: {
            userId: newUser.id,
            spaceName: data.space.name,
            spaceShort: data.space.short,
            spaceKind: data.space.kind,
            school: data.space.school,
            faculty: data.space.faculty,
            theme: data.space.theme,
            coRepInvites: data.space.coRepInvites || [],
            referralCode: data.referralCode,
          },
        });
      }

      return newUser;
    });

    const { accessToken, refreshToken } = await createTokens(
      user.id,
      user.role,
      [],
      req.headers["user-agent"],
      req.ip,
    );
    setRefreshCookie(res, refreshToken);
    sendVerification(user.id, user.email, user.name).catch(console.error);

    const { passwordHash: _, ...userSafe } = user;

    if (user.repApplicationStatus === "pending") {
      // Spec returns the user payload alongside a 403 so the client can show a
      // pending-review screen. The standard fail() envelope has no data slot, so
      // this one response is built inline.
      res.status(403).json({
        success: false,
        error: {
          code: "REP_APPROVAL_PENDING",
          message: "Rep application is under review",
        },
        data: { user: userSafe, accessToken },
      });
      return;
    }

    ok(res, { user: userSafe, accessToken }, 201);
  },
);

// ---------------------------------------------------------------------------
// POST /auth/google (§2.3)
// ---------------------------------------------------------------------------
type UserWithSpaces = User & { spaceMemberships: SpaceMembership[]; spaceReps: SpaceRep[] };

const googleSchema = z
  .object({
    idToken: z.string().min(1),
    matricNo: z.string().min(1).optional(),
    role: z.enum(["student", "rep"]).default("student"),
    referralCode: z.string().optional(),
    space: spaceDraftSchema.optional(),
  })
  .refine(
    (data) => data.role !== "rep" || !!data.space,
    { message: "space is required when role is rep", path: ["space"] },
  );

authRouter.post(
  "/google",
  authLimiter,
  validate(googleSchema),
  async (req: Request, res: Response): Promise<void> => {
    if (!env.GOOGLE_CLIENT_ID) {
      fail(res, 501, "NOT_IMPLEMENTED", "Google sign-in is not configured");
      return;
    }

    const data = req.body as z.infer<typeof googleSchema>;

    let identity;
    try {
      identity = await verifyGoogleIdToken(data.idToken);
    } catch {
      fail(res, 401, "INVALID_CREDENTIALS", "Google sign-in could not be verified");
      return;
    }
    if (!identity.emailVerified) {
      fail(res, 401, "INVALID_CREDENTIALS", "Google account's email is not verified");
      return;
    }

    let user: UserWithSpaces | null = await db.user.findUnique({
      where: { email: identity.email },
      include: { spaceMemberships: true, spaceReps: true },
    });

    if (!user) {
      if (!data.matricNo) {
        errors.validation(res, [
          { field: "matricNo", issue: "required on first sign-in" },
        ]);
        return;
      }

      const created = await db.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            id: generateId("user"),
            name: identity!.name,
            email: identity!.email,
            emailVerified: true,
            matricNo: data.matricNo,
            role: "student", // Everyone starts as a student; reps are provisioned on admin approval
            repApplicationStatus: data.role === "rep" ? "pending" : "none",
          },
        });

        if (data.role === "rep" && data.space) {
          await tx.repApplication.create({
            data: {
              userId: newUser.id,
              spaceName: data.space.name,
              spaceShort: data.space.short,
              spaceKind: data.space.kind,
              school: data.space.school,
              faculty: data.space.faculty,
              theme: data.space.theme,
              coRepInvites: data.space.coRepInvites || [],
              referralCode: data.referralCode,
            },
          });
        }

        return newUser;
      });

      user = { ...created, spaceMemberships: [], spaceReps: [] };
    }

    if (user.isSuspended) {
      fail(res, 403, "ACCOUNT_SUSPENDED", "Your account has been suspended");
      return;
    }
    if (user.isDeactivated) {
      fail(res, 403, "ACCOUNT_DEACTIVATED", "Your account has been deactivated");
      return;
    }

    const spaceIds = [
      ...user.spaceMemberships.map((m) => m.spaceId),
      ...user.spaceReps.map((r) => r.spaceId),
    ];

    const { accessToken, refreshToken } = await createTokens(
      user.id,
      user.role,
      spaceIds,
      req.headers["user-agent"],
      req.ip,
    );
    setRefreshCookie(res, refreshToken);

    const { passwordHash: _, ...userSafe } = user;

    if (user.repApplicationStatus === "pending") {
      res.status(403).json({
        success: false,
        error: {
          code: "REP_APPROVAL_PENDING",
          message: "Rep application is under review",
        },
        data: { user: userSafe, accessToken },
      });
      return;
    }

    ok(res, { user: userSafe, accessToken });
  },
);

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
const loginSchema = z.object({
  email: z
    .string()
    .email()
    .transform((e) => e.toLowerCase()),
  password: z.string(),
});

authRouter.post(
  "/login",
  authLimiter,
  validate(loginSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body;

    const user = await db.user.findUnique({
      where: { email },
      include: { spaceMemberships: true, spaceReps: true },
    });

    if (
      !user ||
      !user.passwordHash ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      errors.unauthorized(res, "Invalid email or password");
      return;
    }

    if (user.isSuspended) {
      fail(res, 403, "ACCOUNT_SUSPENDED", "Your account has been suspended");
      return;
    }

    if (user.isDeactivated) {
      fail(
        res,
        403,
        "ACCOUNT_DEACTIVATED",
        "Your account has been deactivated",
      );
      return;
    }

    const spaceIds = [
      ...user.spaceMemberships.map((m) => m.spaceId),
      ...user.spaceReps.map((r) => r.spaceId),
    ];

    const { accessToken, refreshToken } = await createTokens(
      user.id,
      user.role,
      spaceIds,
      req.headers["user-agent"],
      req.ip,
    );
    setRefreshCookie(res, refreshToken);

    const { passwordHash: _, ...userSafe } = user;

    if (user.repApplicationStatus === "pending") {
      res.status(403).json({
        success: false,
        error: {
          code: "REP_APPROVAL_PENDING",
          message: "Rep application is under review",
        },
        data: { user: userSafe, accessToken },
      });
      return;
    }

    ok(res, { user: userSafe, accessToken });
  },
);

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------
authRouter.post(
  "/refresh",
  async (req: Request, res: Response): Promise<void> => {
    const token = req.cookies.refreshToken;
    if (!token) {
      errors.unauthorized(res, "No refresh token provided");
      return;
    }

    try {
      const payload = await verifyRefreshToken(token);
      const tokenHash = hashToken(token);

      const storedToken = await db.refreshToken.findUnique({
        where: { tokenHash },
      });
      if (
        !storedToken ||
        storedToken.revokedAt ||
        storedToken.expiresAt < new Date()
      ) {
        clearRefreshCookie(res);
        errors.unauthorized(res, "Invalid or expired refresh token");
        return;
      }

      const user = await db.user.findUnique({
        where: { id: payload.sub },
        include: { spaceMemberships: true, spaceReps: true },
      });

      if (!user || user.isSuspended || user.isDeactivated) {
        clearRefreshCookie(res);
        errors.unauthorized(res, "Account inactive");
        return;
      }

      const spaceIds = [
        ...user.spaceMemberships.map((m) => m.spaceId),
        ...user.spaceReps.map((r) => r.spaceId),
      ];

      // Revoke old token (rotation)
      await db.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date() },
      });

      // Issue new tokens
      const { accessToken, refreshToken } = await createTokens(
        user.id,
        user.role,
        spaceIds,
        req.headers["user-agent"],
        req.ip,
      );
      setRefreshCookie(res, refreshToken);

      ok(res, { accessToken });
    } catch (err) {
      clearRefreshCookie(res);
      errors.unauthorized(res, "Invalid refresh token");
    }
  },
);

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
authRouter.post(
  "/logout",
  async (req: Request, res: Response): Promise<void> => {
    const token = req.cookies.refreshToken;
    if (token) {
      const tokenHash = hashToken(token);
      await db.refreshToken
        .updateMany({
          where: { tokenHash, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        .catch(() => {});
    }
    clearRefreshCookie(res);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// POST /auth/verify-email
// ---------------------------------------------------------------------------
const verifyEmailSchema = z.object({ token: z.string() });
authRouter.post(
  "/verify-email",
  validate(verifyEmailSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { token } = req.body;
    const hashedToken = hashToken(token);

    const verification = await db.emailVerification.findUnique({
      where: { token: hashedToken },
    });

    if (
      !verification ||
      verification.usedAt ||
      verification.expiresAt < new Date()
    ) {
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        "Invalid or expired verification token",
      );
      return;
    }

    await db.$transaction([
      db.emailVerification.update({
        where: { id: verification.id },
        data: { usedAt: new Date() },
      }),
      db.user.update({
        where: { id: verification.userId },
        data: { emailVerified: true },
      }),
    ]);

    ok(res, { verified: true });
  },
);

// ---------------------------------------------------------------------------
// POST /auth/forgot-password
// ---------------------------------------------------------------------------
const forgotPasswordSchema = z.object({
  email: z
    .string()
    .email()
    .transform((e) => e.toLowerCase()),
});
authRouter.post(
  "/forgot-password",
  authLimiter,
  validate(forgotPasswordSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body;
    const user = await db.user.findUnique({ where: { email } });

    if (user) {
      // Fire and forget
      sendPasswordReset(user.id, user.email, user.name).catch(console.error);
    }

    // Always return 200
    ok(res, { message: "If an account exists, a reset link has been sent." });
  },
);

// ---------------------------------------------------------------------------
// POST /auth/reset-password
// ---------------------------------------------------------------------------
const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8),
});
authRouter.post(
  "/reset-password",
  authLimiter,
  validate(resetPasswordSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { token, password } = req.body;
    const hashedToken = hashToken(token);

    const reset = await db.passwordReset.findUnique({
      where: { tokenHash: hashedToken },
    });

    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      fail(res, 400, "VALIDATION_ERROR", "Invalid or expired reset token");
      return;
    }

    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

    await db.$transaction([
      db.passwordReset.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      }),
      db.user.update({
        where: { id: reset.userId },
        data: { passwordHash },
      }),
      // Invalidate all active refresh tokens for security
      db.refreshToken.updateMany({
        where: { userId: reset.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    ok(res, { success: true });
  },
);

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------
authRouter.get(
  "/me",
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthenticatedRequest).user.sub;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        phone: true,
        avatarUrl: true,
        role: true,
        repApplicationStatus: true,
        matricNo: true,
        level: true,
        walletBalance: true,
        referralCode: true,
        createdAt: true,
        spaceMemberships: {
          select: {
            space: {
              select: {
                id: true,
                name: true,
                short: true,
                kind: true,
                hue: true,
              },
            },
          },
        },
        spaceReps: {
          select: {
            space: {
              select: {
                id: true,
                name: true,
                short: true,
                kind: true,
                hue: true,
                joinCode: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      errors.notFound(res, "User not found");
      return;
    }

    const spaces = [
      ...user.spaceMemberships.map((m) => ({
        ...m.space,
        membership: "member",
      })),
      ...user.spaceReps.map((r) => ({ ...r.space, membership: "rep" })), // Simplify for now
    ];

    const { spaceMemberships: _, spaceReps: __, ...userSafe } = user;

    ok(res, { ...userSafe, spaces });
  },
);
