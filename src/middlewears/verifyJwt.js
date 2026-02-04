import jwt from "jsonwebtoken";

export function verifyJwt(req, res, next) {
  const token = req.headers["token"];
  if (token) {
    jwt.verify(token, "secret", (err, result) => {
      if (err) {
        res
          .status(401)
          .json({ code: 401, status: "Error", error: "Authentication failed" });
      } else {
        req.body.id = result.id;
        next();
      }
    });
  } else {
    res
      .status(401)
      .json({ code: 401, status: "Error", error: "Authentication failed" });
  }
}
