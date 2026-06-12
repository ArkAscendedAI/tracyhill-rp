import { createApp } from "./app/createApp";
import { seedDemoUser } from "./domain/users/seedDemoUser";

const { app, env, logger } = createApp();

if (env.exposeAuthCodes && process.env.NODE_ENV === "production") {
  throw new Error("EXPOSE_AUTH_CODES=1 is not allowed in production — verification codes would be returned in API responses");
}

if (env.seedDemoUser) {
  await seedDemoUser(env.dbFile, env.demoUsername, env.demoPassword);
}

app.listen(env.port, () => {
  logger.info({ port: env.port, dbFile: env.dbFile }, "api started");
});
