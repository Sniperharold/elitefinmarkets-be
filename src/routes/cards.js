import { Router } from "express";
import { prisma } from "../utils/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// POST /api/cards/request — submit a card delivery request
router.post("/request", async (req, res) => {
  const { fullName, deliveryAddress, city, state, zipCode, country, phone } = req.body;

  if (!fullName || !deliveryAddress || !city || !zipCode || !country || !phone) {
    return res.status(400).json({ error: "All required fields must be provided." });
  }

  const existing = await prisma.cardRequest.findFirst({
    where: { userId: req.user.id },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return res.status(409).json({ error: "You already have a card request.", request: existing });
  }

  const request = await prisma.cardRequest.create({
    data: {
      userId: req.user.id,
      fullName,
      deliveryAddress,
      city,
      state: state || null,
      zipCode,
      country,
      phone,
      status: "processing",
    },
  });

  res.status(201).json({ message: "Card request submitted successfully.", request });
});

// GET /api/cards/my-card — get the user's card request
router.get("/my-card", async (req, res) => {
  const request = await prisma.cardRequest.findFirst({
    where: { userId: req.user.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(request || null);
});

export default router;
