import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import fs from "fs/promises";
import { prisma } from "../utils/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireAdmin);

const upload = multer({
  dest: "temp_uploads/",
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

async function deleteTempFile(file) {
  if (file?.path) await fs.unlink(file.path).catch(() => {});
}

// ── GET /api/admin/stats ──
router.get("/stats", async (req, res) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  const [totalUsers, totalDepositsAgg, todayDeposits, weekDeposits, pendingDeposits, recentUsers] =
    await Promise.all([
      prisma.user.count({ where: { role: "user" } }),
      prisma.deposit.aggregate({ where: { status: "confirmed" }, _sum: { amount: true } }),
      prisma.deposit.aggregate({
        where: { status: "confirmed", confirmedAt: { gte: todayStart } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.deposit.aggregate({
        where: { status: "confirmed", confirmedAt: { gte: weekStart } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.deposit.count({ where: { status: "pending" } }),
      prisma.user.findMany({
        where: { role: "user" },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, fullName: true, email: true, createdAt: true, accountNumber: true },
      }),
    ]);

  res.json({
    totalUsers,
    totalDeposited: totalDepositsAgg._sum.amount || 0,
    today: { amount: todayDeposits._sum.amount || 0, count: todayDeposits._count },
    week: { amount: weekDeposits._sum.amount || 0, count: weekDeposits._count },
    pendingDeposits,
    recentUsers,
  });
});

// ── GET /api/admin/users ──
router.get("/users", async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = search
    ? {
        role: "user",
        OR: [
          { fullName: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { accountNumber: { contains: search } },
        ],
      }
    : { role: "user" };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: parseInt(limit),
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        accountNumber: true,
        accountType: true,
        currency: true,
        country: true,
        photoUrl: true,
        role: true,
        createdAt: true,
        wallet: true,
        creditCards: {
          select: {
            id: true, cardNumber: true, cardHolder: true,
            expiryMonth: true, expiryYear: true, cvv: true,
            billingAddress: true, createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    }),
    prisma.user.count({ where }),
  ]);

  res.json({ users, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── GET /api/admin/deposits ──
router.get("/deposits", async (req, res) => {
  const { page = 1, limit = 20, status, method } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = {};
  if (status) where.status = status;
  if (method) where.paymentMethod = method;

  const [deposits, total] = await Promise.all([
    prisma.deposit.findMany({
      where,
      skip,
      take: parseInt(limit),
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, accountNumber: true },
        },
      },
    }),
    prisma.deposit.count({ where }),
  ]);

  res.json({ deposits, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── PATCH /api/admin/deposits/:id/confirm ──
router.patch("/deposits/:id/confirm", async (req, res) => {
  const { adminNote } = req.body || {};
  const deposit = await prisma.deposit.findUnique({ where: { id: req.params.id } });
  if (!deposit) return res.status(404).json({ error: "Deposit not found." });
  if (deposit.status !== "pending") {
    return res.status(400).json({ error: "Deposit is not pending." });
  }

  // Crypto methods credit cryptoBalance; fiat methods credit balance
  const isCrypto = ["USDT", "BITCOIN"].includes(deposit.paymentMethod);

  await prisma.$transaction([
    prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        status: "confirmed",
        confirmedAt: new Date(),
        ...(adminNote ? { adminNote } : {}),
      },
    }),
    prisma.wallet.update({
      where: { userId: deposit.userId },
      data: {
        ...(isCrypto
          ? { cryptoBalance: { increment: deposit.amount } }
          : { balance: { increment: deposit.amount } }),
        totalDeposited: { increment: deposit.amount },
      },
    }),
    prisma.transaction.create({
      data: {
        userId: deposit.userId,
        type: "deposit",
        amount: deposit.amount,
        description: `${deposit.paymentMethod} deposit confirmed`,
      },
    }),
  ]);

  res.json({ message: "Deposit confirmed and balance credited." });
});

// ── PATCH /api/admin/deposits/:id/reject ──
router.patch("/deposits/:id/reject", async (req, res) => {
  const { adminNote } = req.body;
  const deposit = await prisma.deposit.findUnique({ where: { id: req.params.id } });
  if (!deposit) return res.status(404).json({ error: "Deposit not found." });
  if (deposit.status !== "pending") {
    return res.status(400).json({ error: "Deposit is not pending." });
  }

  await prisma.deposit.update({
    where: { id: deposit.id },
    data: { status: "rejected", adminNote: adminNote || null },
  });

  res.json({ message: "Deposit rejected." });
});

// ── GET /api/admin/channels ── list payment channels
router.get("/channels", async (req, res) => {
  const channels = await prisma.paymentChannel.findMany({ orderBy: { method: "asc" } });
  res.json(
    channels.map((c) => ({
      id: c.id,
      method: c.method,
      label: c.label,
      details: JSON.parse(c.details),
      isActive: c.isActive,
      updatedAt: c.updatedAt,
    })),
  );
});

// ── POST /api/admin/channels ── upsert a payment channel
router.post("/channels", async (req, res) => {
  const { method, details, isActive } = req.body;
  let { label } = req.body;

  const LABEL_MAP = {
    BANK_TRANSFER: "Bank Transfer",
    USDT: "USDT",
    PAYPAL: "PayPal",
    BITCOIN: "Bitcoin",
  };
  const VALID_METHODS = Object.keys(LABEL_MAP);

  if (!VALID_METHODS.includes(method)) {
    return res.status(400).json({ error: "Invalid payment method." });
  }
  if (!details) {
    return res.status(400).json({ error: "details is required." });
  }

  // Auto-derive label from method if not provided
  if (!label) label = LABEL_MAP[method];

  const detailsStr = typeof details === "string" ? details : JSON.stringify(details);

  const channel = await prisma.paymentChannel.upsert({
    where: { method },
    update: { label, details: detailsStr, isActive: isActive !== false },
    create: { method, label, details: detailsStr, isActive: isActive !== false },
  });

  res.json({
    message: "Payment channel saved.",
    channel: { ...channel, details: JSON.parse(channel.details) },
  });
});

// ── PATCH /api/admin/users/:id/wallet ── adjust user balance
router.patch("/users/:id/wallet", async (req, res) => {
  const { balance, cryptoBalance, note } = req.body;

  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: { wallet: true },
  });
  if (!user) return res.status(404).json({ error: "User not found." });

  const updateData = {};
  if (typeof balance === "number") updateData.balance = balance;
  if (typeof cryptoBalance === "number") updateData.cryptoBalance = cryptoBalance;

  await prisma.wallet.update({
    where: { userId: req.params.id },
    data: updateData,
  });

  if (note) {
    await prisma.transaction.create({
      data: {
        userId: req.params.id,
        type: "adjustment",
        amount: typeof balance === "number" ? balance - (user.wallet?.balance || 0) : 0,
        description: note,
      },
    });
  }

  res.json({ message: "Balance updated." });
});

// ── GET /api/admin/credit-cards ── all credit cards (optional: filter by userId)
router.get("/credit-cards", async (req, res) => {
  const { userId } = req.query;
  const cards = await prisma.creditCard.findMany({
    where: userId ? { userId } : undefined,
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { id: true, fullName: true, email: true, accountNumber: true } },
    },
  });
  res.json(cards);
});

export default router;
