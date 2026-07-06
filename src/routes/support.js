// backend/src/routes/support.js
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../utils/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  subject: z.string().min(3, "Subject too short").max(120),
  category: z.enum([
    "general",
    "deposit",
    "transfer",
    "account",
    "technical",
  ]),
  priority: z.enum(["low", "normal", "urgent"]).default("normal"),
  body: z.string().min(10, "Message too short").max(5000),
});

// ── GET /api/support/tickets ── list user's tickets
router.get("/tickets", async (req, res) => {
  const tickets = await prisma.supportTicket.findMany({
    where: { userId: req.user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, body: true, createdAt: true },
      },
    },
  });
  res.json(tickets);
});

// ── GET /api/support/tickets/:id ── single ticket with messages
router.get("/tickets/:id", async (req, res) => {
  const ticket = await prisma.supportTicket.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, body: true, createdAt: true },
      },
    },
  });
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });
  res.json(ticket);
});

// ── POST /api/support/tickets ── create ticket
router.post("/tickets", async (req, res) => {
  try {
    const data = createSchema.parse(req.body);

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user.id,
        subject: data.subject,
        message: data.body,
        category: data.category,
        priority: data.priority,
        status: "open",
        messages: {
          create: {
            role: "user",
            body: data.body,
            userId: req.user.id,
          },
        },
      },
      include: {
        messages: true,
      },
    });

    res.status(201).json(ticket);
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: err.errors[0].message });
    console.error(err);
    res.status(500).json({ error: "Failed to create ticket." });
  }
});

// ── POST /api/support/tickets/:id/reply ── user replies to ticket
router.post("/tickets/:id/reply", async (req, res) => {
  const { body } = req.body;
  if (!body?.trim())
    return res.status(400).json({ error: "Reply cannot be empty." });

  const ticket = await prisma.supportTicket.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });
  if (ticket.status === "closed")
    return res.status(400).json({ error: "This ticket is closed." });

  await prisma.$transaction([
    prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        userId: req.user.id,
        role: "user",
        body: body.trim(),
      },
    }),
    // Reopen if resolved so admin sees the new reply
    prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: ticket.status === "resolved" ? "open" : ticket.status,
        updatedAt: new Date(),
      },
    }),
  ]);

  const updated = await prisma.supportTicket.findUnique({
    where: { id: ticket.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  res.json(updated);
});

export default router;
