import { rateLimit, type Options, type Store } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { type Request } from "express";
import { fail } from "../lib/response";
import { getRedis } from "../lib/redis";
import { type AuthenticatedRequest } from "./auth";

/**
 * Every limiter is built here. With REDIS_URL set, counters live in Redis, so
 * a limit means the same thing however many API instances are running (and
 * survives a deploy); without it they are per process, as before.
 *
 * Each limiter gets its own key prefix, or two limiters keyed on the same IP
 * would count each other's requests. If Redis fails, the request passes
 * (passOnStoreError): a rate limit is never worth blocking payments over.
 */
function limiter(name: string, options: Partial<Options>) {
  const redis = getRedis();
  let store: Store | undefined;
  if (redis) {
    const redisStore = new RedisStore({
      prefix: `rl:${name}:`,
      sendCommand: (command: string, ...args: string[]) => {
        // Not connected (down, or still connecting at boot): fail at once
        // rather than queueing behind timeouts, so an outage adds no latency.
        if (redis.status !== 'ready') return Promise.reject(new Error('redis not ready')) as Promise<never>;
        return redis.call(command, ...args) as Promise<never>;
      },
    });
    // The store loads its Lua scripts as it is built; if Redis isn't up yet
    // that rejects before anything awaits it. Its first use reloads them.
    const scripts = redisStore as unknown as { incrementScriptSha?: Promise<unknown>; getScriptSha?: Promise<unknown> };
    scripts.incrementScriptSha?.catch(() => {});
    scripts.getScriptSha?.catch(() => {});
    store = failOpen(redisStore);
  }
  return rateLimit({ ...options, ...(store ? { store } : {}), passOnStoreError: true });
}

/**
 * A store that lets the request through when Redis fails, quietly: the
 * library would otherwise print a stack trace per request for the whole
 * outage. The outage itself is logged once a minute by src/lib/redis.ts.
 */
export function failOpen(inner: RedisStore): Store {
  let windowMs = 60_000;
  return {
    prefix: inner.prefix,
    init(options) {
      windowMs = options.windowMs;
      inner.init(options);
    },
    async increment(key) {
      try {
        return await inner.increment(key);
      } catch {
        return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
      }
    },
    async decrement(key) {
      await inner.decrement(key).catch(() => {});
    },
    async resetKey(key) {
      await inner.resetKey(key).catch(() => {});
    },
  };
}

export const standardLimiter = limiter("standard", {
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
export const authLimiter = limiter("auth", {
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
export const lookupLimiter = limiter("lookup", {
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
export const checkoutLimiter = limiter("checkout", {
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) =>
    (req as AuthenticatedRequest).user?.sub ?? req.ip ?? "anon",
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many payment attempts, please slow down.");
  },
});

// Money-out and identity endpoints (withdrawals, KYC, name enquiry): 10/min per user.
export const sensitiveLimiter = limiter("sensitive", {
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) =>
    (req as AuthenticatedRequest).user?.sub ?? req.ip ?? "anon",
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many requests, please slow down.");
  },
});

// Feedback form: 5 per 10 minutes per user — plenty for real feedback, not for spam.
export const feedbackLimiter = limiter("feedback", {
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
export const inviteLimiter = limiter("invite", {
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
export const guestLinkLimiter = limiter("guestLink", {
  windowMs: 60 * 1000,
  max: 600,
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many requests from your network, please try again in a minute.");
  },
});

// Starting a guest payment opens a real one-time account at 9jaPay, so one
// person stays at 10 a minute (keyed by account when signed in, else by
// network + email)…
export const guestCheckoutPersonLimiter = limiter("guestCheckoutPerson", {
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
export const guestCheckoutNetworkLimiter = limiter("guestCheckoutNetwork", {
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
export const guestCheckoutStatusLimiter = limiter("guestCheckoutStatus", {
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req: Request) => `${req.ip ?? "anon"}:${String(req.params.reference ?? "")}`,
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "Too many requests, please slow down.");
  },
});

// "Create my account" / "send the link again" emails the guest: 5 per 10
// minutes per checkout is plenty for a real person and useless for spam.
export const guestAccountLimiter = limiter("guestAccount", {
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req: Request) => `${req.ip ?? "anon"}:${String(req.params.reference ?? "")}`,
  handler: (req, res) => {
    fail(res, 429, "RATE_LIMITED", "We've sent this a few times already — check your inbox, or try again in a few minutes.");
  },
});
