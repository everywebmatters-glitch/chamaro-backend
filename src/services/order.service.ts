import type { FastifyBaseLogger } from "fastify";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { httpError, pageMeta } from "../shared/http.js";
import {
  computeTotals,
  fromMinor,
  mergeCartLines,
  toMinor,
  unitPriceMinor,
  unitsPerProduct,
  type CartLineInput,
  type ShippingMethod,
} from "../shared/order-pricing.js";
import { sendOrderConfirmationEmail, sendShipmentEmail, type OrderEmailAddress } from "./email.service.js";

// Orders and the server-side cart. Rules that protect the data:
//  - items come from the customer's stored cart, never from the checkout request; unit prices are read from the
//    database inside the transaction, so a client can neither choose a price nor a total;
//  - stock is reserved with one conditional UPDATE per product (reservedQuantity += n only while
//    quantity - reservedQuantity >= n), so concurrent buyers can never reserve more than exists;
//  - the same Idempotency-Key from the same customer returns the order already created, never a second one;
//  - an order is PENDING and UNPAID; nothing here marks it paid (that needs a verified payment provider);
//  - customer emails go out only after the transaction has committed, and a failed email never undoes the order.

type Db = PrismaClient | Prisma.TransactionClient;

// InnoDB may pick one of two overlapping transactions as a deadlock victim (Prisma reports P2034). The work is
// rolled back completely, so running it again is safe (orders are protected by their Idempotency-Key).
async function retryOnConflict<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if ((error as { code?: string }).code !== "P2034" || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.random() * 25));
    }
  }
}

const orderInclude = { items: { orderBy: { id: "asc" as const } } } satisfies Prisma.RetailOrderInclude;
const adminOrderInclude = { ...orderInclude, customer: { select: { id: true, customerType: true, user: { select: { id: true, name: true, email: true } } } } } satisfies Prisma.RetailOrderInclude;

type OrderRow = Prisma.RetailOrderGetPayload<{ include: typeof orderInclude }>;

// Orders an admin may mark as shipped. COMPLETED and CANCELLED are final; SHIPPED is handled separately.
const SHIPPABLE_STATUSES = new Set(["PENDING", "CONFIRMED", "PROCESSING"]);
// Chamaro has no cash on delivery: an order ships only once its payment is PAID, which only a verified payment
// provider confirmation may set. The fulfilment status (PENDING/CONFIRMED/PROCESSING) never implies payment.
// No payment provider is integrated yet, so no order can be shipped until one is.

export function presentOrder<T extends OrderRow>(order: T) {
  const { shippingAddressSnapshot, ...rest } = order;
  const money = (value: { toString(): string }) => fromMinor(toMinor(value));
  return {
    ...rest,
    subtotal: money(order.subtotal),
    shippingTotal: money(order.shippingTotal),
    total: money(order.total),
    shippingAddress: shippingAddressSnapshot,
    items: order.items.map((item) => ({ ...item, unitPrice: money(item.unitPrice), lineTotal: fromMinor(toMinor(item.unitPrice) * item.quantity) })),
  };
}

// The fields of a presented order that the customer emails use.
type PresentedOrder = { id: string; createdAt: Date; subtotal: string; shippingTotal: string; total: string; shippingMethod: string | null; items: { productName: string | null; variantName: string | null; quantity: number; lineTotal: string }[]; shippingAddress: unknown };

function emailParts(order: Pick<PresentedOrder, "items" | "shippingAddress">) {
  return {
    items: order.items.map((item) => ({ productName: item.productName, variantName: item.variantName, quantity: item.quantity, lineTotal: item.lineTotal })),
    shippingAddress: (order.shippingAddress ?? null) as OrderEmailAddress | null,
  };
}

export function createOrderService(prisma: PrismaClient, options: { log?: FastifyBaseLogger } = {}) {
  // Only the error code is logged: the provider's error can echo the message, which holds the customer's address.
  function logEmailFailure(error: unknown, orderId: string, message: string) {
    options.log?.error({ err: { code: (error as { code?: unknown }).code }, orderId }, message);
  }

  async function sendConfirmation(userId: string, order: PresentedOrder) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
      if (!user) return;
      await sendOrderConfirmationEmail(user.email, {
        id: order.id,
        createdAt: order.createdAt,
        customerName: user.name,
        subtotal: order.subtotal,
        shippingTotal: order.shippingTotal,
        total: order.total,
        shippingMethod: order.shippingMethod,
        ...emailParts(order),
      });
    } catch (error) {
      logEmailFailure(error, order.id, "Order confirmation email failed");
    }
  }

  async function customerFor(userId: string) {
    return prisma.customer.upsert({ where: { userId }, create: { userId, customerType: "RETAIL" }, update: {}, select: { id: true } });
  }

  // ---- cart ------------------------------------------------------------------------------------------------

  async function readCart(db: Db, customerId: string) {
    const cart = await db.cart.findUnique({
      where: { customerId },
      include: { items: { orderBy: { createdAt: "asc" }, include: { product: { include: { inventory: true, images: { orderBy: { position: "asc" }, take: 1 } } }, variant: true } } },
    });
    const items = (cart?.items ?? []).map((item) => {
      const unitMinor = unitPriceMinor(item.product, item.variant);
      const available = item.product.inventory ? Math.max(0, item.product.inventory.quantity - item.product.inventory.reservedQuantity) : null;
      const issues: string[] = [];
      if (item.product.status !== "ACTIVE" || (item.variant && item.variant.status !== "ACTIVE")) issues.push("UNAVAILABLE");
      else if (available !== null && item.quantity > available) issues.push("INSUFFICIENT_STOCK");
      return {
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        product: { id: item.product.id, name: item.product.name, slug: item.product.slug, image: item.product.images[0]?.mediaId ? `/api/v1/media/${item.product.images[0].mediaId}` : (item.product.images[0]?.url ?? null) },
        variant: item.variant ? { id: item.variant.id, name: item.variant.name, sku: item.variant.sku } : null,
        unitPrice: fromMinor(unitMinor),
        lineTotal: fromMinor(unitMinor * item.quantity),
        availableQuantity: available,
        issues,
      };
    });
    const subtotalMinor = items.reduce((sum, item) => sum + toMinor(item.unitPrice) * item.quantity, 0);
    return { items, subtotal: fromMinor(subtotalMinor), updatedAt: cart?.updatedAt ?? null };
  }

  return {
    customerFor,

    async getCart(userId: string) {
      const customer = await customerFor(userId);
      return readCart(prisma, customer.id);
    },

    // Replaces the whole cart. Every line must be an ACTIVE product (and ACTIVE variant of that product); a line
    // wanting more than the stock is accepted (the cart reports it) and checked again when the order is placed.
    async replaceCart(userId: string, lines: CartLineInput[]) {
      const customer = await customerFor(userId);
      const merged = mergeCartLines(lines);
      return retryOnConflict(() => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM Customer WHERE id = ${customer.id} FOR UPDATE`;
        if (merged.length > 0) {
          const products = await tx.product.findMany({ where: { id: { in: [...new Set(merged.map((line) => line.productId))] } }, select: { id: true, status: true, name: true, variants: { select: { id: true, status: true } } } });
          const byId = new Map(products.map((product) => [product.id, product]));
          for (const line of merged) {
            const product = byId.get(line.productId);
            if (!product || product.status !== "ACTIVE") throw httpError(400, "ITEM_UNAVAILABLE", "A product in the cart is not available");
            if (line.variantId) {
              const variant = product.variants.find((candidate) => candidate.id === line.variantId);
              if (!variant || variant.status !== "ACTIVE") throw httpError(400, "ITEM_UNAVAILABLE", `A variant of ${product.name} is not available`);
            }
          }
        }
        const cart = await tx.cart.upsert({ where: { customerId: customer.id }, create: { customerId: customer.id }, update: {}, select: { id: true } });
        // Update, add and remove lines by id instead of deleting the whole cart and re-inserting it: deleting by cart
        // takes gap locks that make two customers saving their carts at the same moment deadlock.
        const current = await tx.cartItem.findMany({ where: { cartId: cart.id }, select: { id: true, productId: true, variantId: true, quantity: true } });
        const keyOf = (line: { productId: string; variantId: string | null }) => `${line.productId}\u0000${line.variantId ?? ""}`;
        const wanted = new Map(merged.map((line) => [keyOf(line), line]));
        const kept = new Set<string>();
        for (const line of current) {
          const key = keyOf(line);
          const next = wanted.get(key);
          if (!next || kept.has(key)) await tx.cartItem.delete({ where: { id: line.id } });
          else {
            kept.add(key);
            if (next.quantity !== line.quantity) await tx.cartItem.update({ where: { id: line.id }, data: { quantity: next.quantity } });
          }
        }
        for (const [key, line] of wanted) if (!kept.has(key)) await tx.cartItem.create({ data: { cartId: cart.id, ...line } });
        await tx.cart.update({ where: { id: cart.id }, data: { updatedAt: new Date() } });
        return readCart(tx, customer.id);
      }));
    },

    async clearCart(userId: string) {
      const customer = await customerFor(userId);
      await prisma.cartItem.deleteMany({ where: { cart: { customerId: customer.id } } });
    },

    // ---- orders ----------------------------------------------------------------------------------------------

    async createOrder(userId: string, input: { idempotencyKey: string; addressId: string; shippingMethod: ShippingMethod; note?: string }) {
      const customer = await customerFor(userId);

      const result = await retryOnConflict(() => prisma.$transaction(
        async (tx) => {
          // One checkout per customer at a time: a second request (a retry, a double click, another tab) waits here,
          // then finds either the order the first one made (same key) or an empty cart.
          await tx.$queryRaw`SELECT id FROM Customer WHERE id = ${customer.id} FOR UPDATE`;

          const existing = await tx.retailOrder.findUnique({ where: { customerId_idempotencyKey: { customerId: customer.id, idempotencyKey: input.idempotencyKey } }, include: orderInclude });
          if (existing) return { order: presentOrder(existing), replay: true };

          const address = await tx.retailAddress.findFirst({ where: { id: input.addressId, customerId: customer.id } });
          if (!address) throw httpError(404, "ADDRESS_NOT_FOUND", "Delivery address not found");

          const cart = await tx.cart.findUnique({
            where: { customerId: customer.id },
            include: { items: { orderBy: { createdAt: "asc" }, include: { product: { include: { inventory: true } }, variant: true } } },
          });
          if (!cart || cart.items.length === 0) throw httpError(400, "CART_EMPTY", "Your cart is empty");

          for (const item of cart.items) {
            const unavailable = item.product.status !== "ACTIVE" || (item.variantId !== null && (!item.variant || item.variant.status !== "ACTIVE" || item.variant.productId !== item.productId));
            if (unavailable) throw httpError(409, "ITEM_UNAVAILABLE", `${item.product.name} is no longer available`);
          }

          // Products are locked (shared) in id order before any stock row, matching the admin product save
          // (product first, then variants/inventory), so the two cannot deadlock.
          const wanted = unitsPerProduct(cart.items);
          const productIds = [...wanted.keys()].sort();
          await tx.$queryRaw`SELECT id FROM Product WHERE id IN (${Prisma.join(productIds)}) ORDER BY id FOR SHARE`;

          for (const productId of productIds) {
            const item = cart.items.find((candidate) => candidate.productId === productId)!;
            if (!item.product.inventory) continue; // stock isn't tracked for this product
            const quantity = wanted.get(productId)!;
            const reserved = await tx.$executeRaw`UPDATE Inventory SET reservedQuantity = reservedQuantity + ${quantity}, updatedAt = NOW(3) WHERE productId = ${productId} AND quantity - reservedQuantity >= ${quantity}`;
            if (reserved === 0) throw httpError(409, "INSUFFICIENT_STOCK", `Not enough stock for ${item.product.name}`);
          }

          const lines = cart.items.map((item) => ({ item, unitMinor: unitPriceMinor(item.product, item.variant) }));
          const totals = computeTotals(lines.map((line) => ({ unitMinor: line.unitMinor, quantity: line.item.quantity })), input.shippingMethod);

          const order = await tx.retailOrder.create({
            data: {
              customerId: customer.id,
              status: "PENDING",
              paymentStatus: "UNPAID",
              subtotal: fromMinor(totals.subtotalMinor),
              shippingTotal: fromMinor(totals.shippingMinor),
              total: fromMinor(totals.totalMinor),
              shippingMethod: input.shippingMethod,
              shippingAddressId: address.id,
              shippingAddressSnapshot: { name: address.name, phone: address.phone, addressLine1: address.addressLine1, addressLine2: address.addressLine2, city: address.city, state: address.state, postalCode: address.postalCode, country: address.country },
              note: input.note ?? null,
              idempotencyKey: input.idempotencyKey,
              items: {
                create: lines.map(({ item, unitMinor }) => ({
                  productId: item.productId,
                  variantId: item.variantId,
                  quantity: item.quantity,
                  unitPrice: fromMinor(unitMinor),
                  productName: item.product.name,
                  variantName: item.variant?.name ?? null,
                  sku: item.variant?.sku ?? item.product.sku ?? null,
                })),
              },
            },
            include: orderInclude,
          });
          await tx.cartItem.deleteMany({ where: { id: { in: cart.items.map((item) => item.id) } } });
          return { order: presentOrder(order), replay: false };
        },
        { maxWait: 5_000, timeout: 20_000 },
      ));
      // The transaction has committed. A replayed Idempotency-Key returns the existing order and sends nothing:
      // the customer lock above means exactly one request per key ever sees replay: false.
      if (!result.replay) await sendConfirmation(userId, result.order);
      return result;
    },

    async listOrders(userId: string, page: number, limit: number) {
      const customer = await customerFor(userId);
      const where = { customerId: customer.id };
      const [rows, total] = await prisma.$transaction([
        prisma.retailOrder.findMany({ where, include: orderInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
        prisma.retailOrder.count({ where }),
      ]);
      return { data: rows.map(presentOrder), meta: pageMeta(page, limit, total) };
    },

    // Someone else's order is reported as not found, so order ids can't be probed.
    async getOrder(userId: string, orderId: string) {
      const customer = await customerFor(userId);
      const order = await prisma.retailOrder.findFirst({ where: { id: orderId, customerId: customer.id }, include: orderInclude });
      if (!order) throw httpError(404, "NOT_FOUND", "Order not found");
      return presentOrder(order);
    },

    // An unpaid order that is still PENDING can be cancelled by its customer; its stock reservation is released.
    async cancelOrder(userId: string, orderId: string) {
      const customer = await customerFor(userId);
      return retryOnConflict(() => prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM RetailOrder WHERE id = ${orderId} AND customerId = ${customer.id} FOR UPDATE`;
        if (locked.length === 0) throw httpError(404, "NOT_FOUND", "Order not found");
        const order = await tx.retailOrder.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
        if (order.status === "CANCELLED") return presentOrder(order);
        if (order.status !== "PENDING" || order.paymentStatus !== "UNPAID") throw httpError(409, "ORDER_NOT_CANCELLABLE", "This order can no longer be cancelled here");

        const released = unitsPerProduct(order.items);
        const productIds = [...released.keys()].sort();
        await tx.$queryRaw`SELECT id FROM Product WHERE id IN (${Prisma.join(productIds)}) ORDER BY id FOR SHARE`;
        for (const productId of productIds) {
          const quantity = released.get(productId)!;
          await tx.$executeRaw`UPDATE Inventory SET reservedQuantity = GREATEST(reservedQuantity - ${quantity}, 0), updatedAt = NOW(3) WHERE productId = ${productId}`;
        }
        const cancelled = await tx.retailOrder.update({ where: { id: orderId }, data: { status: "CANCELLED" }, include: orderInclude });
        return presentOrder(cancelled);
      }));
    },

    // ---- admin -----------------------------------------------------------------------------------------------

    async adminListOrders(query: { page: number; limit: number; status?: string; paymentStatus?: string; search?: string }) {
      const search = query.search?.trim();
      const where: Prisma.RetailOrderWhereInput = {
        ...(query.status ? { status: query.status as never } : {}),
        ...(query.paymentStatus ? { paymentStatus: query.paymentStatus as never } : {}),
        ...(search ? { OR: [{ id: search }, { customer: { user: { email: { contains: search } } } }, { customer: { user: { name: { contains: search } } } }] } : {}),
      };
      const [rows, total] = await prisma.$transaction([
        prisma.retailOrder.findMany({ where, include: adminOrderInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
        prisma.retailOrder.count({ where }),
      ]);
      return { data: rows.map(presentOrder), meta: pageMeta(query.page, query.limit, total) };
    },

    // Marks an order SHIPPED with the carrier and tracking number an admin entered by hand, then emails the
    // customer. Repeating the same request returns the order without a second email; a different tracking number
    // for an order that has already shipped is refused. No shipping-provider API is called.
    async adminShipOrder(orderId: string, input: { carrier: string; trackingNumber: string }) {
      const result = await retryOnConflict(() => prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM RetailOrder WHERE id = ${orderId} FOR UPDATE`;
        if (locked.length === 0) throw httpError(404, "NOT_FOUND", "Order not found");
        const order = await tx.retailOrder.findUniqueOrThrow({ where: { id: orderId }, include: adminOrderInclude });
        if (order.status === "SHIPPED") {
          if (order.carrier === input.carrier && order.trackingNumber === input.trackingNumber) return { order, shipped: false };
          throw httpError(409, "ORDER_ALREADY_SHIPPED", "This order has already been marked as shipped");
        }
        if (!SHIPPABLE_STATUSES.has(order.status)) throw httpError(409, "ORDER_NOT_SHIPPABLE", `A ${order.status.toLowerCase()} order can't be marked as shipped`);
        if (order.paymentStatus !== "PAID") throw httpError(409, "ORDER_NOT_PAID", "Only orders with a verified online payment can be shipped");
        const shipped = await tx.retailOrder.update({
          where: { id: orderId },
          data: { status: "SHIPPED", carrier: input.carrier, trackingNumber: input.trackingNumber, shippedAt: new Date() },
          include: adminOrderInclude,
        });
        return { order: shipped, shipped: true };
      }));

      const order = presentOrder(result.order);
      if (result.shipped) {
        try {
          await sendShipmentEmail(result.order.customer.user.email, {
            id: order.id,
            customerName: result.order.customer.user.name,
            carrier: input.carrier,
            trackingNumber: input.trackingNumber,
            shippedAt: result.order.shippedAt!,
            ...emailParts(order),
          });
        } catch (error) {
          logEmailFailure(error, order.id, "Shipment email failed");
        }
      }
      return order;
    },

    async adminGetOrder(orderId: string) {
      const order = await prisma.retailOrder.findUnique({ where: { id: orderId }, include: adminOrderInclude });
      if (!order) throw httpError(404, "NOT_FOUND", "Order not found");
      return presentOrder(order);
    },
  };
}

export type OrderService = ReturnType<typeof createOrderService>;
