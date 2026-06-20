import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { prisma } from "../utils/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

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

const registerSchema = z.object({
  fullName: z.string().min(2, "Full name too short"),
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().min(7, "Invalid phone number"),
  dateOfBirth: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  zipCode: z.string().optional(),
  currency: z.string().default("USD"),
  accountType: z.string().default("savings"),
  transactionPin: z.string().min(4).max(6).optional(),
  promoCode: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function issueToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function generateAccountNumber() {
  const prefix = "4920";
  const suffix = Math.floor(10000000 + Math.random() * 90000000).toString();
  return prefix + suffix;
}

// ── POST /api/auth/register ──
router.post("/register", async (req, res) => {
  try {
    const data = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({
      where: { email: data.email },
    });
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);
    const isAdmin = data.email.toLowerCase() === process.env.ADMIN_EMAIL?.toLowerCase();

    let transactionPinHash = null;
    if (data.transactionPin) {
      transactionPinHash = await bcrypt.hash(data.transactionPin, 10);
    }

    // Generate unique account number
    let accountNumber;
    let attempts = 0;
    do {
      accountNumber = generateAccountNumber();
      const exists = await prisma.user.findUnique({ where: { accountNumber } });
      if (!exists) break;
      attempts++;
    } while (attempts < 10);

    const user = await prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        passwordHash,
        fullName: data.fullName,
        phone: data.phone,
        dateOfBirth: data.dateOfBirth || null,
        address: data.address || null,
        city: data.city || null,
        country: data.country || null,
        zipCode: data.zipCode || null,
        currency: data.currency || "USD",
        accountType: data.accountType || "savings",
        accountNumber,
        transactionPin: transactionPinHash,
        promoCode: data.promoCode || null,
        role: isAdmin ? "admin" : "user",
        wallet: {
          create: {
            balance: 0,
            cryptoBalance: 0,
            totalDeposited: 0,
            totalWithdrawn: 0,
          },
        },
      },
      include: { wallet: true },
    });

    const token = issueToken(user.id);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.session.create({ data: { userId: user.id, token, expiresAt } });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        currency: user.currency,
        accountType: user.accountType,
        accountNumber: user.accountNumber,
        photoUrl: user.photoUrl,
        role: user.role,
        wallet: user.wallet,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0].message });
    }
    console.error(err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// ── POST /api/auth/login ──
router.post("/login", async (req, res) => {
  try {
    const data = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email: data.email.toLowerCase() },
      include: { wallet: true },
    });

    if (!user) return res.status(401).json({ error: "Invalid email or password." });

    const valid = await bcrypt.compare(data.password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password." });

    const token = issueToken(user.id);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.session.create({ data: { userId: user.id, token, expiresAt } });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        currency: user.currency,
        accountType: user.accountType,
        accountNumber: user.accountNumber,
        photoUrl: user.photoUrl,
        role: user.role,
        wallet: user.wallet,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request." });
    }
    console.error(err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ── POST /api/auth/logout ──
router.post("/logout", requireAuth, async (req, res) => {
  await prisma.session.deleteMany({ where: { token: req.token } });
  res.json({ message: "Logged out." });
});

// ── GET /api/auth/me ──
router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      dateOfBirth: true,
      address: true,
      city: true,
      country: true,
      zipCode: true,
      currency: true,
      accountType: true,
      accountNumber: true,
      photoUrl: true,
      role: true,
      createdAt: true,
      wallet: true,
    },
  });
  res.json(user);
});

// ── PATCH /api/auth/profile ── update display name + optional fields
router.patch("/profile", requireAuth, async (req, res) => {
  const { fullName, phone, address, city, country, zipCode } = req.body;

  if (fullName !== undefined && (typeof fullName !== "string" || fullName.trim().length < 2)) {
    return res.status(400).json({ error: "Full name must be at least 2 characters." });
  }

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      ...(fullName ? { fullName: fullName.trim() } : {}),
      ...(phone ? { phone } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(city !== undefined ? { city } : {}),
      ...(country !== undefined ? { country } : {}),
      ...(zipCode !== undefined ? { zipCode } : {}),
    },
    select: {
      id: true, email: true, fullName: true, phone: true,
      address: true, city: true, country: true, zipCode: true,
      currency: true, accountType: true, accountNumber: true, photoUrl: true, role: true,
    },
  });

  res.json({ message: "Profile updated successfully.", user: updated });
});

// ── PATCH /api/auth/password ── change password
router.patch("/password", requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: "Both old and new passwords are required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  if (oldPassword === newPassword) {
    return res.status(400).json({ error: "New password must differ from your current one." });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const valid = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect." });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } }),
    prisma.session.deleteMany({ where: { userId: req.user.id } }),
  ]);

  res.json({ message: "Password updated successfully. Please log in again." });
});

// ── PATCH /api/auth/pin ── set or change transaction PIN
router.patch("/pin", requireAuth, async (req, res) => {
  const { pin, password } = req.body;

  if (!pin || !/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: "PIN must be 4–6 digits." });
  }
  if (!password) {
    return res.status(400).json({ error: "Password confirmation is required." });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Password is incorrect." });

  const transactionPin = await bcrypt.hash(pin, 10);
  await prisma.user.update({ where: { id: req.user.id }, data: { transactionPin } });

  res.json({ message: "Transaction PIN updated successfully." });
});

// ── PATCH /api/auth/photo ── upload profile photo
router.patch("/photo", requireAuth, upload.single("photo"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No photo provided." });
  }
  try {
    const ext = EXT_MAP[req.file.mimetype] || ".jpg";
    const filename = `${req.file.filename}${ext}`;
    const destDir = path.join(process.cwd(), "uploads", "photos");
    await fs.mkdir(destDir, { recursive: true });
    await fs.rename(req.file.path, path.join(destDir, filename));
    const photoUrl = `/uploads/photos/${filename}`;

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { photoUrl },
      select: { id: true, photoUrl: true },
    });

    res.json({ message: "Photo updated.", photoUrl: updated.photoUrl });
  } catch (err) {
    await deleteTempFile(req.file);
    console.error(err);
    res.status(500).json({ error: "Failed to upload photo." });
  }
});

export default router;
