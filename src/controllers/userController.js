import { User } from "../models/user";
import bcrypt from "bcryptjs";

// Register User
export const createUser = async (req, res, next) => {
  try {
    const userData = req.body;
    const findUser = await User.findOne({ email: userData?.email });
    if(findUser){
      res.status(400).json({
        code: 400,
        status: "Error",
        message: "Email address already exists!"
      });
  } else {
    const salt = await bcrypt.genSalt(10);
    userData.password = await bcrypt.hash(req.body.password, salt);
    const user = await User.create(userData);
    res.status(200).json({
      code: 200,
      status: "Success",
      message: "User Register successfully!",
      user,
    });
  }
  } catch (error) {
    next(error);
    res.status(500).json({ code: 500, status: "Error", error });
  }
};

// Login User
export const userLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email });
    if (user) {
      const verifyPassword = await bcrypt.compare(password, user.password);
      if (verifyPassword) {
        const userObject = user.toObject();
        delete userObject.password;
        res.status(200).json({
          code: 200,
          status: "Success",
          message: "Successfully logedIn",
          user: userObject,
          // token,
        });
      } else {
        res.status(400).json({
          code: 400,
          status: "Error",
          message: "Invalid credentials",
        });
      }
    } else {
      res.status(400).json({
        code: 400,
        status: "Error",
        message: "Invalid credentials",
      });
    }
  } catch (error) {
    next(error);
    res.status(500).json({ code: 500, status: "Error", error });
  }
};

// Update User Data

export const userUpdate = async (req, res, next) => {
  try {
    const saveData = req.body;
    let user = await User.findOne({ email: saveData.email });
    if (user) {
      const allowedUpdates = {};
      if (saveData.subscription_date !== null) {
        allowedUpdates.subscription_date = saveData.subscription_date;
      }
      if (saveData.terms_accepted !== null) {
        allowedUpdates.terms_accepted = saveData.terms_accepted === 'true' || saveData.terms_accepted === true;
      }
      if (Object.keys(allowedUpdates).length === 0) {
        return res.status(400).json({
          code: 400,
          status: "Error",
          message: "No valid fields to update.",
        });
      }
      await User.findOneAndUpdate(
        { email: saveData.email },
        { $set: allowedUpdates },
      );
      user = await User.findOne({ email: saveData.email });
      res.status(200).json({
        code: 200,
        status: "Success",
        message: "User date updated!",
        user,
      });
    } else {
      res.status(400).json({
        code: 400,
        status: "Error",
        message: "Email address not found!",
      });
    }
  } catch (error) {
    next(error);
    res.status(500).json({ code: 500, status: "Error", error });
  }
};

//get all users
export const getUser = async (req, res, next) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (user) {
      res.status(200).json({
        code: 200,
        status: "Success",
        message: "User fetched successfully!",
        user,
      });
    }
    else {
      res.status(400).json({
        code: 400,
        status: "Error",
        message: "Email address not found!",
      });
    }
  } catch (error) {
    next(error);
  }
};
