import { User } from "../../models/user";
import { verifyAccessToken } from "../services/tokenService";

const unauthorized = (res, message = "Authentication required") =>
  res.status(401).json({ status: "Error", code: "unauthorized", message });

/**
 * Bearer-token authentication.
 *
 * The token's `tv` claim is checked against the account's current
 * token_version, so incrementing that field invalidates every access token
 * already issued - which is what makes password reset and account deletion
 * take effect immediately rather than at the next expiry.
 */
export const requireAuth = async (req, res, next) => {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) return unauthorized(res);

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (error) {
    const expired = error.name === "TokenExpiredError";
    return unauthorized(res, expired ? "Access token expired" : "Invalid access token");
  }

  const user = await User.findById(claims.sub);
  if (!user || user.status !== "active") return unauthorized(res);

  if ((claims.tv ?? 0) !== (user.token_version ?? 0)) {
    return unauthorized(res, "Session is no longer valid");
  }

  req.user = user;
  return next();
};
