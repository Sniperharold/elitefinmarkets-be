import { Router } from "express";
import { prisma } from "../utils/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// POST /api/transfers
router.post("/", async (req, res) => {
  const { amount, recipientAccount, recipientName, description, walletType = "bank" } = req.body;

  if (!amount || !recipientAccount || !recipientName) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: "Invalid amount." });
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId: req.user.id } });
  if (!wallet) return res.status(404).json({ error: "Wallet not found." });

  const currentBalance = walletType === "crypto" ? wallet.cryptoBalance : wallet.balance;
  if (currentBalance < amt) {
    return res.status(400).json({ error: "Insufficient balance." });
  }

  await prisma.$transaction([
    prisma.wallet.update({
      where: { userId: req.user.id },
      data: {
        ...(walletType === "crypto"
          ? { cryptoBalance: { decrement: amt } }
          : { balance: { decrement: amt } }),
        totalWithdrawn: { increment: amt },
      },
    }),
    prisma.transaction.create({
      data: {
        userId: req.user.id,
        type: "transfer",
        amount: -amt,
        description: description || `Transfer to ${recipientName} (Acc: ${recipientAccount})`,
      },
    }),
  ]);

  const updatedWallet = await prisma.wallet.findUnique({ where: { userId: req.user.id } });

  res.json({ message: "Transfer completed successfully.", wallet: updatedWallet });
});

export default router;
