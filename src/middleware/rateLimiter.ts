import { rateLimit } from "express-rate-limit";
import { type Request } from "express";
import { fail } from "../lib/response";
import { type AuthenticatedRequest } from "./auth";

export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  handler: (req, res) => {
    fail(
      res,
      429,
      "RATE_LIMITED",
      "Too many requests, please try again later.",
    );
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // stricter limit for auth routes
  handler: (req, res) => {
    fail(
      res,
      429,
      "RATE_LIMITED",
      "Too many authentication attempts, please try again later.",
    );
  },
});

// Join-code lookup: 10/min per user to prevent code enumeration (§4.3).
export const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) =>
    (req as AuthenticatedRequest).user?.sub ?? req.ip ?? "anon",
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many lookups, please slow down.");
  },
});

// Duey chat assistant: 20/min per user — generous enough for a real
// conversation, tight enough to bound LLM spend/abuse from one account.
export const assistantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req: Request) =>
    (req as AuthenticatedRequest).user?.sub ?? req.ip ?? "anon",
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many messages, please slow down.");
  },
});
