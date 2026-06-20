import { Router } from "express";
import { prisma } from "../utils/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireAdmin);

function formatTicket(ticket) {
  // Derive message from first user TicketMessage if not stored directly
  const firstUserMsg = (ticket.messages || [])
    .filter((m) => m.role === "user")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];

  const lastAdminMsg = (ticket.messages || [])
    .filter((m) => m.role === "admin")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  return {
    ...ticket,
    message: ticket.message || firstUserMsg?.body || null,
    adminReply: ticket.adminReply || lastAdminMsg?.body || null,
  };
}

// ── GET /api/admin/support/tickets ── all tickets
router.get("/", async (req, res) => {
  const { status, page = 1, limit = 50 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const where = status ? { status } : {};

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      skip,
      take: parseInt(limit),
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        messages: {
          orderBy: { createdAt: "asc" },
          select: { id: true, body: true, role: true, createdAt: true, userId: true },
        },
      },
    }),
    prisma.supportTicket.count({ where }),
  ]);

  res.json({ tickets: tickets.map(formatTicket), total });
});

// ── GET /api/admin/support/tickets/:id ── single ticket with all messages
router.get("/:id", async (req, res) => {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: { id: true, fullName: true, email: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });
  res.json(formatTicket(ticket));
});

// ── POST /api/admin/support/tickets/:id/reply ── admin sends a reply
router.post("/:id/reply", async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: "Reply cannot be empty." });

  const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });

  await prisma.$transaction([
    prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        userId: req.user.id,
        role: "admin",
        body: body.trim(),
      },
    }),
    prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: "in_progress",
        adminReply: body.trim(),
        updatedAt: new Date(),
      },
    }),
  ]);

  const updated = await prisma.supportTicket.findUnique({
    where: { id: ticket.id },
    include: {
      user: { select: { id: true, fullName: true, email: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  res.json(formatTicket(updated));
});

// ── PATCH /api/admin/support/tickets/:id/status ── change status (+ optional reply)
router.patch("/:id/status", async (req, res) => {
  const { status, adminReply } = req.body;
  const valid = ["open", "in_progress", "resolved", "closed"];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }

  const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });

  const ops = [
    prisma.supportTicket.update({
      where: { id: req.params.id },
      data: {
        status,
        updatedAt: new Date(),
        ...(adminReply?.trim() ? { adminReply: adminReply.trim() } : {}),
      },
    }),
  ];

  // If a reply text was provided, also create a TicketMessage
  if (adminReply?.trim()) {
    ops.push(
      prisma.ticketMessage.create({
        data: {
          ticketId: req.params.id,
          userId: req.user.id,
          role: "admin",
          body: adminReply.trim(),
        },
      })
    );
  }

  await prisma.$transaction(ops);

  const updated = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: { id: true, fullName: true, email: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  res.json(formatTicket(updated));
});

export default router;
