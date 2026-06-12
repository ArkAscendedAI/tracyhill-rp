import type { RequestHandler } from "express";

import type { UserRepository } from "../../domain/users/userRepository";

export function createRequireAdmin(users: UserRepository): RequestHandler {
  return (req, res, next) => {
    const userId = req.session.userId;
    if (!userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const user = users.findById(userId);
    if (!user) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    if (user.role !== "admin") {
      res.status(403).json({ error: "admin required" });
      return;
    }
    next();
  };
}
