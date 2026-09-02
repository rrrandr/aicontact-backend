const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

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
