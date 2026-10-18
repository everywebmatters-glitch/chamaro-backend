// Cart, addresses and orders: authorization, validation, server-side pricing, stock reservation and races,
// duplicate protection and rollback, and the order/shipment emails. Runs only against the isolated local test
// database. Every email goes to a fake Resend client, never the real one.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isolatedDatabaseSkipReason } from "../helpers/throwaway-db.js";

const skipReason = await isolatedDatabaseSkipReason();
type App = Awaited<ReturnType<typeof import("../../src/app.js")["buildApp"]>>;

// Emails "sent" by the current test; set failEmails to make the fake provider return an error.
const outbox: { to: string; subject: string; html: string }[] = [];
let failEmails = false;
const { setEmailClientForTests } = await import("../../src/services/email.service.js");
setEmailClientForTests({ emails: { send: async (message) => { outbox.push(message); return { error: failEmails ? { message: "provider down" } : null }; } } });

async function withShop(run: (shop: Shop) => Promise<void>) {
  outbox.length = 0;
  failEmails = false;
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();
  const shop = new Shop(app);
  try {
    await run(shop);
  } finally {
    await shop.cleanup();
    await app.close();
  }
}

class Shop {
  unique = randomBytes(5).toString("hex");
  userIds: string[] = [];
  productIds: string[] = [];
  categoryId?: string;
  private counter = 0;
  constructor(readonly app: App) {}

  async category() {
    this.categoryId ??= (await this.app.prisma.category.create({ data: { name: `Orders ${this.unique}`, slug: `orders-${this.unique}` } })).id;
    return this.categoryId;
  }

  // A product with an optional stock level (undefined = stock not tracked) and variants.
  async product(options: { price?: string; stock?: number; status?: "ACTIVE" | "DRAFT" | "ARCHIVED"; variants?: { name: string; price?: string; status?: "ACTIVE" | "ARCHIVED" }[] } = {}) {
    const n = ++this.counter;
    const created = await this.app.prisma.product.create({
      data: {
        name: `Chair ${n} ${this.unique}`,
        slug: `chair-${n}-${this.unique}`,
        price: options.price ?? "1000.00",
        status: options.status ?? "ACTIVE",
        categoryId: await this.category(),
        ...(options.stock !== undefined ? { inventory: { create: { quantity: options.stock } } } : {}),
        ...(options.variants ? { variants: { create: options.variants.map((variant, index) => ({ name: variant.name, sku: `SKU-${n}-${index}-${this.unique}`, price: variant.price ?? null, options: {}, status: variant.status ?? "ACTIVE" })) } } : {}),
      },
      include: { variants: true, inventory: true },
    });
    this.productIds.push(created.id);
    return created;
  }

  async customer(label = "c") {
    const user = await this.app.prisma.user.create({ data: { name: `Customer ${label}`, email: `${label}-${this.unique}-${++this.counter}@example.test`, passwordHash: "unused", role: "CUSTOMER", customer: { create: { customerType: "RETAIL" } } }, include: { customer: true } });
    this.userIds.push(user.id);
    return { user, customerId: user.customer!.id, headers: { authorization: `Bearer ${this.app.jwt.sign({ sub: user.id, role: "CUSTOMER" })}` } };
  }

  async admin() {
    const user = await this.app.prisma.user.create({ data: { name: "Orders Admin", email: `admin-${this.unique}-${++this.counter}@example.test`, passwordHash: "unused", role: "ADMIN" } });
    this.userIds.push(user.id);
    return { headers: { authorization: `Bearer ${this.app.jwt.sign({ sub: user.id, role: "ADMIN" })}` } };
  }

  address(headers: Record<string, string>, over: Record<string, unknown> = {}) {
    return this.app.inject({ method: "POST", url: "/api/v1/addresses", headers, payload: { name: "Asha Rao", phone: "+91 98765 43210", addressLine1: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: "560001", ...over } });
  }

  putCart(headers: Record<string, string>, items: object[]) {
    return this.app.inject({ method: "PUT", url: "/api/v1/cart", headers, payload: { items } });
  }

  order(headers: Record<string, string>, body: object, key = `key-${randomBytes(8).toString("hex")}`) {
    return this.app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...headers, "idempotency-key": key }, payload: body });
  }

  async reserved(productId: string) {
    return (await this.app.prisma.inventory.findUniqueOrThrow({ where: { productId } })).reservedQuantity;
  }

  async cleanup() {
    const { prisma } = this.app;
    const customers = await prisma.customer.findMany({ where: { userId: { in: this.userIds } }, select: { id: true } }).catch(() => []);
    await prisma.retailOrder.deleteMany({ where: { customerId: { in: customers.map((c) => c.id) } } }).catch(() => undefined);
    await prisma.product.deleteMany({ where: { id: { in: this.productIds } } }).catch(() => undefined);
    if (this.categoryId) await prisma.category.delete({ where: { id: this.categoryId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: this.userIds } } }).catch(() => undefined);
  }
}

// Customer with an address and a cart of one product, ready to check out.
async function readyCustomer(shop: Shop, productId: string, quantity = 1, label = "buyer") {
  const customer = await shop.customer(label);
  const address = (await shop.address(customer.headers)).json().data.id as string;
  assert.equal((await shop.putCart(customer.headers, [{ productId, quantity }])).statusCode, 200);
  return { ...customer, address };
}

// ---- authorization ------------------------------------------------------------------------------------------------

test("cart, addresses and orders require a customer; admin order routes require an admin", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const customer = await shop.customer();
    const admin = await shop.admin();
    const address = { name: "A", phone: "12345", addressLine1: "x", city: "c", state: "s", postalCode: "560001" };
    const routes: [string, string, object | undefined][] = [
      ["GET", "/api/v1/cart", undefined],
      ["PUT", "/api/v1/cart", { items: [] }],
      ["DELETE", "/api/v1/cart", undefined],
      ["GET", "/api/v1/addresses", undefined],
      ["POST", "/api/v1/addresses", address],
      ["PUT", "/api/v1/addresses/x", { city: "c" }],
      ["DELETE", "/api/v1/addresses/x", undefined],
      ["POST", "/api/v1/orders", { addressId: "x", shippingMethod: "standard" }],
      ["GET", "/api/v1/orders", undefined],
      ["GET", "/api/v1/orders/x", undefined],
      ["POST", "/api/v1/orders/x/cancel", undefined],
      ["GET", "/api/v1/admin/orders", undefined],
      ["GET", "/api/v1/admin/orders/x", undefined],
      ["POST", "/api/v1/admin/orders/x/ship", { carrier: "Blue Dart", trackingNumber: "BD123" }],
    ];
    for (const [method, url, payload] of routes) {
      const anonymous = await app.inject({ method: method as "GET", url, headers: { "idempotency-key": "anonymous-key-1" }, payload });
      assert.equal(anonymous.statusCode, 401, `${method} ${url} without a token`);
      const wrongRole = await app.inject({ method: method as "GET", url, headers: { ...(url.includes("/admin/") ? customer.headers : admin.headers), "idempotency-key": "wrong-role-key-1" }, payload });
      assert.equal(wrongRole.statusCode, 403, `${method} ${url} with the wrong kind of token`);
    }
  }));

test("a customer cannot see, change or cancel another customer's data", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const product = await shop.product({ stock: 5 });
    const owner = await readyCustomer(shop, product.id, 1, "owner");
    const intruder = await shop.customer("intruder");
    const placed = await shop.order(owner.headers, { addressId: owner.address, shippingMethod: "standard" });
    assert.equal(placed.statusCode, 201, placed.body);
    const orderId = placed.json().data.id as string;

    assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${orderId}`, headers: intruder.headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/cancel`, headers: intruder.headers })).statusCode, 404);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/v1/orders", headers: intruder.headers })).json().data, []);
    assert.equal((await app.inject({ method: "PUT", url: `/api/v1/addresses/${owner.address}`, headers: intruder.headers, payload: { city: "Hacked" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/addresses/${owner.address}`, headers: intruder.headers })).statusCode, 404);
    await shop.putCart(intruder.headers, [{ productId: product.id, quantity: 1 }]);
    assert.equal((await shop.order(intruder.headers, { addressId: owner.address, shippingMethod: "standard" })).statusCode, 404, "someone else's address is not found");
    assert.equal((await app.prisma.retailAddress.findUniqueOrThrow({ where: { id: owner.address } })).city, "Bengaluru");
    assert.equal((await app.prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId } })).status, "PENDING");
  }));

// ---- cart ----------------------------------------------------------------------------------------------------------

test("the cart is stored on the server with server prices, merges duplicates and rejects unavailable items", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const customer = await shop.customer();
    const plain = await shop.product({ price: "250.50", stock: 10 });
    const withVariants = await shop.product({ price: "1000.00", variants: [{ name: "Black", price: "1200.00" }, { name: "Grey" }, { name: "Retired", status: "ARCHIVED" }] });
    const [black, grey, retired] = withVariants.variants;
    const archived = await shop.product({ status: "ARCHIVED" });
    const draft = await shop.product({ status: "DRAFT" });

    const saved = await shop.putCart(customer.headers, [
      { productId: plain.id, quantity: 2 },
      { productId: plain.id, quantity: 3 },
      { productId: withVariants.id, variantId: black.id, quantity: 1 },
      { productId: withVariants.id, variantId: grey.id, quantity: 2 },
    ]);
    assert.equal(saved.statusCode, 200, saved.body);
    const cart = saved.json().data;
    assert.equal(cart.items.length, 3, "the two plain lines merged");
    assert.equal(cart.items.find((item: any) => item.productId === plain.id).quantity, 5);
    assert.equal(cart.items.find((item: any) => item.variantId === black.id).unitPrice, "1200.00", "variant price wins");
    assert.equal(cart.items.find((item: any) => item.variantId === grey.id).unitPrice, "1000.00", "a variant without a price uses the product price");
    assert.equal(cart.subtotal, "4452.50"); // 5 x 250.50 + 1200 + 2 x 1000
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/cart", headers: customer.headers })).json().data.subtotal, "4452.50");

    // Rejected carts change nothing.
    for (const bad of [
      [{ productId: archived.id, quantity: 1 }],
      [{ productId: draft.id, quantity: 1 }],
      [{ productId: "no-such-product", quantity: 1 }],
      [{ productId: withVariants.id, variantId: retired.id, quantity: 1 }],
      [{ productId: plain.id, variantId: black.id, quantity: 1 }],
    ]) {
      const rejected = await shop.putCart(customer.headers, bad);
      assert.equal(rejected.statusCode, 400, JSON.stringify(bad));
      assert.equal(rejected.json().error.code, "ITEM_UNAVAILABLE");
    }
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/cart", headers: customer.headers })).json().data.items.length, 3, "a rejected replace leaves the cart as it was");

    // Shape validation: quantities, extra keys (a client-supplied price is not accepted).
    for (const bad of [[{ productId: plain.id, quantity: 0 }], [{ productId: plain.id, quantity: 100 }], [{ productId: plain.id, quantity: 1.5 }], [{ productId: plain.id, quantity: 1, price: 1 }], [{ quantity: 1 }]]) {
      assert.equal((await shop.putCart(customer.headers, bad)).statusCode, 400, JSON.stringify(bad));
    }

    // Stock problems are reported, not hidden.
    const scarce = await shop.product({ stock: 2 });
    const scarceCart = (await shop.putCart(customer.headers, [{ productId: scarce.id, quantity: 3 }])).json().data;
    assert.deepEqual([scarceCart.items[0].availableQuantity, scarceCart.items[0].issues], [2, ["INSUFFICIENT_STOCK"]]);

    assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/cart", headers: customer.headers })).statusCode, 204);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/v1/cart", headers: customer.headers })).json().data.items, []);
  }));

// ---- addresses -----------------------------------------------------------------------------------------------------

test("addresses are validated, owned by one customer, and past orders keep their own copy", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const customer = await shop.customer();
    for (const bad of [{ postalCode: "012345" }, { postalCode: "56001" }, { postalCode: "56000A" }, { phone: "call me" }, { name: "   " }, { city: "" }, { country: "india" }, { type: "HOME" }, { id: "x" }]) {
      assert.equal((await shop.address(customer.headers, bad)).statusCode, 400, JSON.stringify(bad));
    }
    const created = await shop.address(customer.headers, { addressLine2: "Flat 4" });
    assert.equal(created.statusCode, 201, created.body);
    const address = created.json().data;
    assert.deepEqual([address.country, address.type, address.addressLine2], ["IN", "SHIPPING", "Flat 4"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/addresses", headers: customer.headers })).json().data.length, 1);

    const product = await shop.product({ stock: 3 });
    await shop.putCart(customer.headers, [{ productId: product.id, quantity: 1 }]);
    const orderId = (await shop.order(customer.headers, { addressId: address.id, shippingMethod: "standard" })).json().data.id as string;

    const updated = await app.inject({ method: "PUT", url: `/api/v1/addresses/${address.id}`, headers: customer.headers, payload: { city: "Mysuru", postalCode: "570001" } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().data.city, "Mysuru");
    const order = (await app.inject({ method: "GET", url: `/api/v1/orders/${orderId}`, headers: customer.headers })).json().data;
    assert.equal(order.shippingAddress.city, "Bengaluru", "the order kept the address it was placed with");
    assert.equal(order.shippingAddress.postalCode, "560001");

    const inUse = await app.inject({ method: "DELETE", url: `/api/v1/addresses/${address.id}`, headers: customer.headers });
    assert.equal(inUse.statusCode, 409);
    assert.equal(inUse.json().error.code, "RECORD_IN_USE");
    const spare = (await shop.address(customer.headers)).json().data.id;
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/addresses/${spare}`, headers: customer.headers })).statusCode, 204);
    assert.equal((await app.inject({ method: "PUT", url: `/api/v1/addresses/${spare}`, headers: customer.headers, payload: { city: "x" } })).statusCode, 404);
  }));

// ---- creating orders -----------------------------------------------------------------------------------------------

test("an order is priced from the database, reserves stock, empties the cart and is unpaid", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const product = await shop.product({ price: "1000.00", stock: 10 });
    const buyer = await readyCustomer(shop, product.id, 2);

    // Nothing the client sends can set a price, a total, a status or a payment state.
    for (const extra of [{ total: "1.00" }, { subtotal: "1.00" }, { items: [{ productId: product.id, quantity: 1, price: 1 }] }, { status: "COMPLETED" }, { paymentStatus: "PAID" }, { discount: 50 }]) {
      assert.equal((await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard", ...extra })).statusCode, 400, JSON.stringify(extra));
    }
    assert.equal((await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "overnight" })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/orders", headers: buyer.headers, payload: { addressId: buyer.address, shippingMethod: "standard" } })).statusCode, 400, "no Idempotency-Key");
    assert.equal((await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard" }, "short")).statusCode, 400, "key too short");
    assert.equal(await shop.reserved(product.id), 0, "rejected requests reserve nothing");

    // The catalogue price changes after the item went into the cart: the order uses the current price.
    await app.prisma.product.update({ where: { id: product.id }, data: { price: "1100.00" } });
    const placed = await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard", note: "  Leave at the gate  " });
    assert.equal(placed.statusCode, 201, placed.body);
    const order = placed.json().data;
    assert.deepEqual([order.status, order.paymentStatus], ["PENDING", "UNPAID"]);
    assert.deepEqual([order.subtotal, order.shippingTotal, order.total], ["2200.00", "499.00", "2699.00"]);
    assert.equal(order.note, "Leave at the gate");
    assert.equal(order.items.length, 1);
    assert.deepEqual([order.items[0].quantity, order.items[0].unitPrice, order.items[0].lineTotal, order.items[0].productName], [2, "1100.00", "2200.00", product.name]);
    assert.equal(order.shippingAddress.city, "Bengaluru");

    assert.equal(await shop.reserved(product.id), 2, "stock is reserved");
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/v1/cart", headers: buyer.headers })).json().data.items, [], "the cart is emptied");
    const list = (await app.inject({ method: "GET", url: "/api/v1/orders", headers: buyer.headers })).json();
    assert.deepEqual([list.data.length, list.meta.total, list.data[0].id], [1, 1, order.id]);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${order.id}`, headers: buyer.headers })).json().data.total, "2699.00");

    // Empty cart now.
    const again = await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard" });
    assert.equal(again.statusCode, 400);
    assert.equal(again.json().error.code, "CART_EMPTY");
  }));

test("free standard shipping from the threshold, express never free, variant and untracked products work", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const untracked = await shop.product({ price: "6000.00" }); // no inventory row: stock not tracked
    const variants = await shop.product({ price: "3000.00", stock: 4, variants: [{ name: "Walnut", price: "2000.00" }] });
    const buyer = await shop.customer();
    const address = (await shop.address(buyer.headers)).json().data.id;
    await shop.putCart(buyer.headers, [{ productId: untracked.id, quantity: 1 }, { productId: variants.id, variantId: variants.variants[0].id, quantity: 2 }]);
    const standard = (await shop.order(buyer.headers, { addressId: address, shippingMethod: "standard" })).json().data;
    assert.deepEqual([standard.subtotal, standard.shippingTotal, standard.total], ["10000.00", "0.00", "10000.00"]);
    const variantLine = standard.items.find((item: any) => item.variantId === variants.variants[0].id);
    assert.deepEqual([variantLine.unitPrice, variantLine.variantName, variantLine.sku], ["2000.00", "Walnut", variants.variants[0].sku]);
    assert.equal(await shop.reserved(variants.id), 2);

    await shop.putCart(buyer.headers, [{ productId: untracked.id, quantity: 1 }]);
    const express = (await shop.order(buyer.headers, { addressId: address, shippingMethod: "express" })).json().data;
    assert.deepEqual([express.subtotal, express.shippingTotal, express.total], ["6000.00", "999.00", "6999.00"]);
  }));

test("an order that cannot be fulfilled is rejected whole: nothing is reserved and no order exists", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const plenty = await shop.product({ stock: 10 });
    const scarce = await shop.product({ stock: 1 });
    const buyer = await shop.customer();
    const address = (await shop.address(buyer.headers)).json().data.id;
    await shop.putCart(buyer.headers, [{ productId: plenty.id, quantity: 3 }, { productId: scarce.id, quantity: 2 }]);

    const rejected = await shop.order(buyer.headers, { addressId: address, shippingMethod: "standard" });
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().error.code, "INSUFFICIENT_STOCK");
    assert.equal(await shop.reserved(plenty.id), 0, "the reservation made before the failure was rolled back");
    assert.equal(await shop.reserved(scarce.id), 0);
    assert.equal(await app.prisma.retailOrder.count({ where: { customerId: buyer.customerId } }), 0);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/cart", headers: buyer.headers })).json().data.items.length, 2, "the cart is kept so the customer can adjust it");

    // A product that stops being sold between cart and checkout.
    await shop.putCart(buyer.headers, [{ productId: plenty.id, quantity: 1 }, { productId: scarce.id, quantity: 1 }]);
    await app.prisma.product.update({ where: { id: scarce.id }, data: { status: "ARCHIVED" } });
    const gone = await shop.order(buyer.headers, { addressId: address, shippingMethod: "standard" });
    assert.equal(gone.statusCode, 409);
    assert.equal(gone.json().error.code, "ITEM_UNAVAILABLE");
    assert.equal(await shop.reserved(plenty.id), 0);
    assert.equal(await app.prisma.retailOrder.count({ where: { customerId: buyer.customerId } }), 0);
  }));

// ---- races and duplicates ------------------------------------------------------------------------------------------

test("concurrent buyers can never reserve more stock than exists", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const lastUnit = await shop.product({ stock: 1 });
    const two = await shop.product({ stock: 2 });

    const rivals = await Promise.all([1, 2].map((n) => readyCustomer(shop, lastUnit.id, 1, `rival${n}`)));
    const results = await Promise.all(rivals.map((rival) => shop.order(rival.headers, { addressId: rival.address, shippingMethod: "standard" })));
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409], results.map((result) => result.body).join(" | "));
    assert.equal(await shop.reserved(lastUnit.id), 1);
    assert.equal(await app.prisma.retailOrderItem.count({ where: { productId: lastUnit.id } }), 1);

    const crowd = await Promise.all([1, 2, 3, 4, 5].map((n) => readyCustomer(shop, two.id, 1, `crowd${n}`)));
    const crowdResults = await Promise.all(crowd.map((buyer) => shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard" })));
    assert.equal(crowdResults.filter((result) => result.statusCode === 201).length, 2);
    assert.equal(crowdResults.filter((result) => result.statusCode === 409).length, 3);
    assert.equal(await shop.reserved(two.id), 2);
    assert.equal(await app.prisma.retailOrderItem.count({ where: { productId: two.id } }), 2);
  }));

test("retries and double submits with the same Idempotency-Key create one order", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const product = await shop.product({ stock: 10 });
    const buyer = await readyCustomer(shop, product.id, 2);
    const body = { addressId: buyer.address, shippingMethod: "standard" };

    const first = await shop.order(buyer.headers, body, "retry-key-0001");
    assert.equal(first.statusCode, 201, first.body);
    const retry = await shop.order(buyer.headers, body, "retry-key-0001");
    assert.equal(retry.statusCode, 200, "a retry is answered with the existing order");
    assert.equal(retry.json().data.id, first.json().data.id);
    assert.equal(await app.prisma.retailOrder.count({ where: { customerId: buyer.customerId } }), 1);
    assert.equal(await shop.reserved(product.id), 2, "stock reserved once");

    // Simultaneous submits (double click, two tabs).
    const other = await readyCustomer(shop, product.id, 1, "double");
    const burst = await Promise.all([1, 2, 3, 4].map(() => shop.order(other.headers, { addressId: other.address, shippingMethod: "standard" }, "burst-key-0001")));
    assert.deepEqual(burst.map((result) => result.statusCode).sort(), [200, 200, 200, 201], burst.map((result) => result.body).join(" | "));
    assert.equal(new Set(burst.map((result) => result.json().data.id)).size, 1);
    assert.equal(await app.prisma.retailOrder.count({ where: { customerId: other.customerId } }), 1);
    assert.equal(await shop.reserved(product.id), 3);

    // The same key belongs to one customer only.
    const stranger = await readyCustomer(shop, product.id, 1, "stranger");
    const reused = await shop.order(stranger.headers, { addressId: stranger.address, shippingMethod: "standard" }, "retry-key-0001");
    assert.equal(reused.statusCode, 201);
    assert.notEqual(reused.json().data.id, first.json().data.id);
  }));

test("one cart cannot become two orders, even with different keys at the same moment", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const product = await shop.product({ stock: 10 });
    const buyer = await readyCustomer(shop, product.id, 3);
    const results = await Promise.all([1, 2, 3].map((n) => shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard" }, `distinct-key-000${n}`)));
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 400, 400], results.map((result) => result.body).join(" | "));
    assert.equal(await app.prisma.retailOrder.count({ where: { customerId: buyer.customerId } }), 1);
    assert.equal(await shop.reserved(product.id), 3);
  }));

// ---- order and shipment emails -------------------------------------------------------------------------------------

test("a placed order sends one confirmation; retries and double submits with the same key send no more", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const product = await shop.product({ price: "1500.00", stock: 10 });
    const buyer = await readyCustomer(shop, product.id, 2);
    const body = { addressId: buyer.address, shippingMethod: "express" };

    const first = await shop.order(buyer.headers, body, "email-key-0001");
    assert.equal(first.statusCode, 201, first.body);
    const order = first.json().data;
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, buyer.user.email);
    assert.equal(outbox[0].subject, `Your Chamaro order ${order.id}`);
    for (const part of [order.id, product.name, "&times; 2", order.subtotal, order.shippingTotal, order.total, "12 MG Road"]) assert.ok(outbox[0].html.includes(part), part);

    assert.equal((await shop.order(buyer.headers, body, "email-key-0001")).statusCode, 200);
    assert.equal(outbox.length, 1, "a retry sends nothing");

    const other = await readyCustomer(shop, product.id, 1, "double");
    const burst = await Promise.all([1, 2, 3, 4].map(() => shop.order(other.headers, { addressId: other.address, shippingMethod: "standard" }, "email-burst-0001")));
    assert.deepEqual(burst.map((result) => result.statusCode).sort(), [200, 200, 200, 201]);
    assert.equal(outbox.filter((message) => message.to === other.user.email).length, 1, "simultaneous submits send one email");
  }));

test("a failed confirmation email never undoes the order; a rejected order sends nothing", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const product = await shop.product({ stock: 1 });
    const buyer = await readyCustomer(shop, product.id, 1);
    failEmails = true;
    const placed = await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard" });
    assert.equal(placed.statusCode, 201, placed.body);
    assert.equal(outbox.length, 1, "the send was attempted");
    assert.equal(await app.prisma.retailOrder.count({ where: { customerId: buyer.customerId } }), 1);
    assert.equal(await shop.reserved(product.id), 1);

    failEmails = false;
    const late = await readyCustomer(shop, product.id, 1, "late");
    const rejected = await shop.order(late.headers, { addressId: late.address, shippingMethod: "standard" });
    assert.equal(rejected.statusCode, 409);
    assert.equal(outbox.length, 1, "no email for an order that was not placed");
  }));

test("admin ship: records carrier and tracking, emails once, is idempotent, and refuses final states", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const product = await shop.product({ stock: 10 });
    const buyer = await readyCustomer(shop, product.id, 1);
    const orderId = (await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard" })).json().data.id as string;
    outbox.length = 0;
    const ship = (payload: object, id = orderId) => app.inject({ method: "POST", url: `/api/v1/admin/orders/${id}/ship`, headers: admin.headers, payload });

    const shipped = await ship({ carrier: " Blue Dart ", trackingNumber: "BD-77001 " });
    assert.equal(shipped.statusCode, 200, shipped.body);
    const data = shipped.json().data;
    assert.equal(data.status, "SHIPPED");
    assert.equal(data.carrier, "Blue Dart");
    assert.equal(data.trackingNumber, "BD-77001");
    assert.ok(data.shippedAt);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, buyer.user.email);
    assert.ok(outbox[0].html.includes("BD-77001") && outbox[0].html.includes("Blue Dart"));

    const again = await ship({ carrier: "Blue Dart", trackingNumber: "BD-77001" });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().data.shippedAt, data.shippedAt);
    assert.equal(outbox.length, 1, "repeating the same request sends no second email");

    const different = await ship({ carrier: "Delhivery", trackingNumber: "DL-1" });
    assert.equal(different.statusCode, 409);
    assert.equal(different.json().error.code, "ORDER_ALREADY_SHIPPED");

    // The customer sees the tracking details on their own order too.
    const mine = await app.inject({ method: "GET", url: `/api/v1/orders/${orderId}`, headers: buyer.headers });
    assert.equal(mine.json().data.trackingNumber, "BD-77001");

    const cancelled = await readyCustomer(shop, product.id, 1, "cancelled");
    const cancelledId = (await shop.order(cancelled.headers, { addressId: cancelled.address, shippingMethod: "standard" })).json().data.id as string;
    await app.inject({ method: "POST", url: `/api/v1/orders/${cancelledId}/cancel`, headers: cancelled.headers });
    const refused = await ship({ carrier: "Blue Dart", trackingNumber: "BD-2" }, cancelledId);
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error.code, "ORDER_NOT_SHIPPABLE");

    assert.equal((await ship({ carrier: "Blue Dart", trackingNumber: "BD-3" }, "no-such-order")).statusCode, 404);
    assert.equal((await ship({ carrier: "Blue Dart" })).statusCode, 400);
    assert.equal((await ship({ carrier: "Blue Dart", trackingNumber: "<script>" })).statusCode, 400);
  }));

test("admin ship: a failed shipment email still leaves the order shipped", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const product = await shop.product({ stock: 5 });
    const buyer = await readyCustomer(shop, product.id, 1);
    const orderId = (await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard" })).json().data.id as string;
    failEmails = true;
    const shipped = await app.inject({ method: "POST", url: `/api/v1/admin/orders/${orderId}/ship`, headers: admin.headers, payload: { carrier: "India Post", trackingNumber: "EE123456789IN" } });
    assert.equal(shipped.statusCode, 200, shipped.body);
    const stored = await app.prisma.retailOrder.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(stored.status, "SHIPPED");
    assert.equal(stored.trackingNumber, "EE123456789IN");
  }));

// ---- cancelling ----------------------------------------------------------------------------------------------------

test("cancelling an unpaid pending order releases its stock once; paid orders cannot be cancelled this way", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const product = await shop.product({ stock: 5 });
    const buyer = await readyCustomer(shop, product.id, 3);
    const orderId = (await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard" })).json().data.id as string;
    assert.equal(await shop.reserved(product.id), 3);

    const cancelled = await app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/cancel`, headers: buyer.headers });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().data.status, "CANCELLED");
    assert.equal(await shop.reserved(product.id), 0);
    const twice = await app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/cancel`, headers: buyer.headers });
    assert.equal(twice.statusCode, 200);
    assert.equal(await shop.reserved(product.id), 0, "a second cancel releases nothing more");

    // Another order that has been paid (as a payment provider confirmation would set it) is not cancelled here.
    await shop.putCart(buyer.headers, [{ productId: product.id, quantity: 2 }]);
    const paidId = (await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "standard" })).json().data.id as string;
    await app.prisma.retailOrder.update({ where: { id: paidId }, data: { paymentStatus: "PAID", status: "CONFIRMED" } });
    const refused = await app.inject({ method: "POST", url: `/api/v1/orders/${paidId}/cancel`, headers: buyer.headers });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error.code, "ORDER_NOT_CANCELLABLE");
    assert.equal(await shop.reserved(product.id), 2);
  }));

test("the API never marks an order paid", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const product = await shop.product({ stock: 5 });
    const buyer = await readyCustomer(shop, product.id, 1);
    const order = (await shop.order(buyer.headers, { addressId: buyer.address, shippingMethod: "express" })).json().data;
    assert.equal(order.paymentStatus, "UNPAID");
    const attempts = await Promise.all([
      shop.app.inject({ method: "PUT", url: `/api/v1/orders/${order.id}`, headers: buyer.headers, payload: { paymentStatus: "PAID" } }),
      shop.app.inject({ method: "PATCH", url: `/api/v1/orders/${order.id}`, headers: buyer.headers, payload: { paymentStatus: "PAID" } }),
      shop.app.inject({ method: "POST", url: `/api/v1/orders/${order.id}/pay`, headers: buyer.headers, payload: {} }),
    ]);
    assert.deepEqual(attempts.map((attempt) => attempt.statusCode), [404, 404, 404]);
    assert.equal((await shop.app.prisma.retailOrder.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus, "UNPAID");
  }));

// ---- admin ---------------------------------------------------------------------------------------------------------

test("admin order list: pagination, filters, search and detail with the customer", { skip: skipReason }, () =>
  withShop(async (shop) => {
    const { app } = shop;
    const admin = await shop.admin();
    const product = await shop.product({ stock: 20 });
    const a = await readyCustomer(shop, product.id, 1, "alice");
    const b = await readyCustomer(shop, product.id, 1, "bob");
    const orderA = (await shop.order(a.headers, { addressId: a.address, shippingMethod: "standard" })).json().data.id as string;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const orderB = (await shop.order(b.headers, { addressId: b.address, shippingMethod: "standard" })).json().data.id as string;
    await app.inject({ method: "POST", url: `/api/v1/orders/${orderA}/cancel`, headers: a.headers });

    const search = `/api/v1/admin/orders?search=${encodeURIComponent(shop.unique)}`;
    const all = (await app.inject({ method: "GET", url: search, headers: admin.headers })).json();
    assert.deepEqual(all.data.map((order: any) => order.id), [orderB, orderA], "newest first");
    assert.deepEqual([all.meta.total, all.meta.page, all.meta.limit, all.meta.totalPages], [2, 1, 20, 1]);
    assert.equal(all.data[0].customer.user.email.startsWith("bob-"), true);
    assert.equal("passwordHash" in all.data[0].customer.user, false);

    const page1 = (await app.inject({ method: "GET", url: `${search}&limit=1&page=1`, headers: admin.headers })).json();
    const page2 = (await app.inject({ method: "GET", url: `${search}&limit=1&page=2`, headers: admin.headers })).json();
    assert.deepEqual([page1.data.map((o: any) => o.id), page2.data.map((o: any) => o.id), page1.meta.totalPages], [[orderB], [orderA], 2]);
    assert.deepEqual((await app.inject({ method: "GET", url: `${search}&status=CANCELLED`, headers: admin.headers })).json().data.map((o: any) => o.id), [orderA]);
    assert.deepEqual((await app.inject({ method: "GET", url: `${search}&status=PENDING&paymentStatus=UNPAID`, headers: admin.headers })).json().data.map((o: any) => o.id), [orderB]);
    assert.deepEqual((await app.inject({ method: "GET", url: `${search}&paymentStatus=PAID`, headers: admin.headers })).json().data, []);
    assert.deepEqual((await app.inject({ method: "GET", url: `/api/v1/admin/orders?search=${orderA}`, headers: admin.headers })).json().data.map((o: any) => o.id), [orderA], "search by order id");
    for (const bad of ["limit=0", "limit=101", "page=0", "status=SHIPPED2", "paymentStatus=free", "extra=1"]) {
      assert.equal((await app.inject({ method: "GET", url: `/api/v1/admin/orders?${bad}`, headers: admin.headers })).statusCode, 400, bad);
    }

    const detail = (await app.inject({ method: "GET", url: `/api/v1/admin/orders/${orderB}`, headers: admin.headers })).json().data;
    assert.deepEqual([detail.id, detail.items.length, detail.customer.user.name, detail.shippingAddress.postalCode], [orderB, 1, "Customer bob", "560001"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/orders/does-not-exist", headers: admin.headers })).statusCode, 404);
  }));
