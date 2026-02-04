import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import http from "http";
import ErrorHandler from "./middlewears/errorHandler";
import { connectDB } from "./util/db";
import userRouter from "./routes/userRoutes";

dotenv.config();

//cors
const app = express();
app.use(
  cors({
    origin: "*",
  })
);

//parse data into json
app.use(bodyParser.json({ limit: "50mb" }));
app.use(
  bodyParser.urlencoded({
    limit: "50mb",
    extended: true,
  })
);

const port = process.env.PORT || 5000;
connectDB();

//making path public for accessing pictures
app.use("/public", express.static("public"));

app.use("/api/user", userRouter);

//Error handling middlewear
app.use(ErrorHandler);

const server = http.createServer(app);

server.listen(port, () => {
  console.log(`Snap camera listening at http://localhost:${port}`);
});
