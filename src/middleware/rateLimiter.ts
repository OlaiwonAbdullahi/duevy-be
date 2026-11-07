import { rateLimit } from "express-rate-limit";
import { type Request } from "express";
import { fail } from "../lib/response";
import { type AuthenticatedRequest } from "./auth";

// Per IP, and a whole class can share one IP (campus Wi-Fi, a hotspot, mobile
// carrier NAT), so this only stops floods. Per-user limits below guard the
// expensive routes.
export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1500,
  // The guest pay link has its own limits below. A whole class pays a shared
  // link from one campus address (page, checkout, then a status poll every few
  // seconds each), which this IP-wide bucket would cut off after ~70 guests.
  skip: (req: Request) => isGuestPayPath(req.path),
  handler: (req, res) => {
    fail(
      res,
      429,
      "RATE_LIMITED",
      "Too many requests, please try again later.",
    );
  },
});

// Only failed attempts count, so classmates signing up together from one
// network don't lock each other out, while password guessing still does.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
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


// Checkout: 10/min per user. Each checkout opens a real bank account at the
// provider, so this also bounds how fast one account can mint them.
export const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) =>
    (req as AuthenticatedRequest).user?.sub ?? req.ip ?? "anon",
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many payment attempts, please slow down.");
  },
});

// Money-out and identity endpoints (withdrawals, KYC, name enquiry): 10/min per user.
export const sensitiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) =>
    (req as AuthenticatedRequest).user?.sub ?? req.ip ?? "anon",
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many requests, please slow down.");
  },
});

// Feedback form: 5 per 10 minutes per user — plenty for real feedback, not for spam.
export const feedbackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req: Request) =>
    (req as AuthenticatedRequest).user?.sub ?? req.ip ?? "anon",
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "You've sent a lot of feedback recently — try again in a few minutes.");
  },
});

// Referral invites: 20 requests per 24h per user — each request can email up
// to 20 addresses, so this bounds how much mail one account can send.
export const inviteLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req: Request) =>
    (req as AuthenticatedRequest).user?.sub ?? req.ip ?? "anon",
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "You've sent a lot of invites today — try again tomorrow.");
  },
});

// ---------------------------------------------------------------------------
// Guest pay link (/v1/public/dues/…, /v1/public/checkouts/…). Guests have no
// account, so the IP is all there is to key on, and a class shares one campus
// IP. Each limit therefore separates "one person" (tight, as before) from
// "one network" (sized for a class opening the link together).
// ---------------------------------------------------------------------------

/** Paths (relative to /v1) that carry their own guest limits instead of the IP-wide standard one. */
export function isGuestPayPath(path: string): boolean {
  return path.startsWith('/public/dues/') || path.startsWith('/public/checkouts/');
}

const guestEmail = (req: Request): string => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : '';
};

// Viewing the link: a cheap read (two indexed queries, ~8 ms). Due ids are
// random, so there is nothing to enumerate; this only stops floods.
export const guestLinkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many requests from your network, please try again in a minute.");
  },
});

// Starting a guest payment opens a real one-time account at 9jaPay, so one
// person stays at 10 a minute (keyed by account when signed in, else by
// network + email)…
export const guestCheckoutPersonLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) => {
    const sub = (req as AuthenticatedRequest).user?.sub;
    return sub ? `user:${sub}` : `guest:${req.ip ?? "anon"}:${guestEmail(req)}`;
  },
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many payment attempts, please slow down.");
  },
});

// …while a whole network of anonymous guests may start 60 a minute: a class
// of 300 is through in about 5 minutes, and the accounts one address can mint
// at the provider stay bounded.
export const guestCheckoutNetworkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  skip: (req: Request) => !!(req as AuthenticatedRequest).user,
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "A lot of payments are starting from your network right now — please try again in a minute.");
  },
});

// The success page polls its checkout every few seconds; keyed per checkout
// so classmates polling their own payments don't share a bucket. Unknown or
// unauthenticated references never reach the provider (token check first).
export const guestCheckoutStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req: Request) => `${req.ip ?? "anon"}:${String(req.params.reference ?? "")}`,
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many requests, please slow down.");
  },
});

// "Create my account" / "send the link again" emails the guest: 5 per 10
// minutes per checkout is plenty for a real person and useless for spam.
export const guestAccountLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req: Request) => `${req.ip ?? "anon"}:${String(req.params.reference ?? "")}`,
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "We've sent this a few times already — check your inbox, or try again in a few minutes.");
  },
});
