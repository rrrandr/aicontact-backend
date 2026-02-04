const mongoose = require("mongoose");
import dotenv from "dotenv";
dotenv.config();
const URI = process.env.URI;

export const connectDB = async () => {
  try {
    mongoose.connect(URI, {
      useUnifiedTopology: true,
      useNewUrlParser: true,
      ///bufferCommands: false
      useNewUrlParser: true,
    });
    console.log(`Connected to Database.....}`);
  } catch (err) {
    console.log(`Error in connection ${err}}`);
  }
};
