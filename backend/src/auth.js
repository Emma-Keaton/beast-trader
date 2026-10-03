import jwt from "jsonwebtoken";
import { config } from "./config.js";

/**
 * Device-scoped auth (no signup / no login).
 * The frontend owns a persistent device id (X-Device-ID header).
 * POST /api/auth/session exchanges it for a 30-day HS256 JWT.
 * All other endpoints accept either the JWT (Authorization: Bearer)
 * or the raw X-Device-ID header (convenience during development).
 */

export function issueToken(deviceId) {
  return jwt.sign({ sub: deviceId, typ: "device-session" }, config.jwtSecret, {
    expiresIn: `${config.jwtTtlDays}d`,
  });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

export function requireDevice(req, res, next) {
  let deviceId = req.header("X-Device-ID");
  const auth = req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    try {
      deviceId = verifyToken(auth.slice(7)).sub;
    } catch {
      return res.status(401).json({ error: "invalid token" });
    }
  }
  if (!deviceId || typeof deviceId !== "string" || deviceId.length > 64) {
    return res.status(401).json({ error: "missing X-Device-ID" });
  }
  req.deviceId = deviceId;
  next();
}
