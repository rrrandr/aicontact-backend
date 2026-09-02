import express from "express";
import {
  userLogin,
  createUser,
  userUpdate,
  getUser,
} from "../controllers/userController";
import { authLimiter } from "../middlewears/rateLimit";
import { throttle } from "../middlewears/throttle";

const userRouter = express.Router();

// Rejection-based limiting on the two endpoints whose failure path in the
// released clients stops rather than retries.
userRouter.post("/login", authLimiter, userLogin);
userRouter.post("/register", authLimiter, createUser);

// Delay-based throttling on the two endpoints the released clients retry
// forever. See src/middlewears/throttle.js for why these must not 429.
userRouter.get("/:email", throttle, getUser);
userRouter.patch("/update", throttle, userUpdate);

export default userRouter;
