const dotenv = require("dotenv");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

// Real PayPal sandbox, ephemeral local database.
dotenv.config({ path: ".env.sandbox" });

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";
process.env.ENABLE_V2 = "true";
process.env.JWT_ACCESS_SECRET =
  "sandbox-integration-access-secret-long-enough-to-pass";
process.env.BCRYPT_COST = "6";
process.env.RATE_LIMIT_V2_REGISTER = "1000";
process.env.RATE_LIMIT_V2_LOGIN = "1000";
process.env.RATE_LIMIT_V2_ENTITLEMENT = "1000";
process.env.RATE_LIMIT_V2_DELETE = "1000";
process.env.APPLE_PRODUCT_IDS =
  process.env.APPLE_PRODUCT_IDS || "com.facestream.aicontact.monthly";

mongoose.set("strictQuery", true);

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
