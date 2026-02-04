import express from "express";
import {
  userLogin,
  createUser,
  userUpdate,
  getUser,
} from "../controllers/userController";

const userRouter = express.Router();

userRouter.post("/login", userLogin);
userRouter.post("/register", createUser);
userRouter.get("/:email", getUser);
userRouter.patch("/update", userUpdate);

export default userRouter;
