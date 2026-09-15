import type { RequestHandler } from "express";

const WINDOW_MS = 60_000;
const REQUEST_LIMIT = 20;

type RateWindow = {
  count: number;
  expiresAt: number;
};

const windows = new Map<string, RateWindow>();

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

function isSameOrigin(req: Parameters<RequestHandler>[0]): boolean {
  const origin = req.get("origin");
  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]);
    const host = forwardedHost ?? req.get("host");
    const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
    const protocol = forwardedProto ?? req.protocol;
    return parsed.host === host && parsed.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

export const importerAccess: RequestHandler = (req, res, next) => {
  if (!isSameOrigin(req)) {
    res.status(403).json({ status: "Blocked", message: "Cross-origin importer requests are not allowed." });
    return;
  }

  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const current = windows.get(key);
  const window = !current || current.expiresAt <= now
    ? { count: 0, expiresAt: now + WINDOW_MS }
    : current;
  window.count += 1;
  windows.set(key, window);

  if (windows.size > 1_000) {
    for (const [candidate, value] of windows) {
      if (value.expiresAt <= now) windows.delete(candidate);
    }
  }

  res.setHeader("RateLimit-Limit", String(REQUEST_LIMIT));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, REQUEST_LIMIT - window.count)));
  res.setHeader("RateLimit-Reset", String(Math.ceil(window.expiresAt / 1_000)));

  if (window.count > REQUEST_LIMIT) {
    res.status(429).json({ status: "Blocked", message: "Too many importer requests. Try again shortly." });
    return;
  }

  next();
};