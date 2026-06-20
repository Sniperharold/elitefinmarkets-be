import { Router } from "express";
import { prisma } from "../utils/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// ── GET /api/wallet ──
router.get("/", async (req, res) => {
  const wallet = await prisma.wallet.findUnique({
    where: { userId: req.user.id },
  });
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });
  res.json(wallet);
});

// ── GET /api/wallet/transactions ──
router.get("/transactions", async (req, res) => {
  const txs = await prisma.transaction.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(txs);
});

export default router;
