/** Exact execution cash flows, not a cost-basis or realized-profit claim. */
const SCALE = 10n ** 18n;
function decimal(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,30})(?:\.[0-9]{1,18})?$/u.test(value)) throw new TypeError("fill-decimal-invalid");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, "0"));
}
function text(value, digits) {
  const scale = 10n ** BigInt(digits), negative = value < 0n; value = negative ? -value : value;
  const fraction = (value % scale).toString().padStart(digits, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}${value / scale}${fraction ? "." + fraction : ""}`;
}
export function correlateOrderFills(order, fills, { complete = true } = {}) {
  if (!order?.id || !["buy", "sell"].includes(order.side) || typeof order.symbol !== "string" || !Array.isArray(fills) || fills.length > 1000) throw new TypeError("order-fill-binding-required");
  const expected = decimal(order.filled_qty), seen = new Set(); let quantity = 0n, gross = 0n;
  for (const fill of fills) {
    if (typeof fill.id !== "string" || !fill.id.length || seen.has(fill.id)) throw new TypeError("duplicate-or-missing-fill-identity");
    seen.add(fill.id);
    if (fill.activity_type !== "FILL" || fill.order_id !== order.id || fill.side !== order.side || fill.symbol?.replaceAll("/", "") !== order.symbol.replaceAll("/", "") || !Number.isFinite(Date.parse(fill.transaction_time))) throw new TypeError("fill-order-content-mismatch");
    const qty = decimal(fill.qty), price = decimal(fill.price); if (qty <= 0n || price <= 0n) throw new RangeError("positive-fill-quantity-and-price-required");
    quantity += qty; gross += qty * price;
  }
  if (quantity > expected) throw new RangeError("fill-quantity-exceeds-order");
  return Object.freeze({ disposition: complete && quantity === expected ? "order-fills-correlated" : "pending", activityIds: [...seen], filledQuantity: text(quantity, 18), orderFilledQuantity: text(expected, 18), grossCashFlowUsd: text(order.side === "buy" ? -gross : gross, 36), feesReconciled: false, costBasisReconciled: false, realizedPnlUsd: null });
}
export async function readOrderFills(adapter, { grant, orderId, now }) {
  const rows = [], receipts = [], tokens = new Set(); let pageToken;
  for (let page = 0; page < 10; page += 1) {
    const receipt = await adapter.listActivities({ grant, activityType: "FILL", orderId, pageToken, pageSize: 100, now });
    receipts.push(receipt.id);
    if (receipt.status < 200 || receipt.status >= 300 || !Number.isInteger(receipt.status) || !Array.isArray(receipt.payload) || receipt.payload.length > 100) throw new TypeError("order-fill-page-refused");
    rows.push(...receipt.payload);
    if (receipt.payload.length < 100) return { id: receipt.id, status: receipt.status, payload: rows, pageReceipts: receipts, complete: true };
    pageToken = receipt.payload.at(-1)?.id;
    if (typeof pageToken !== "string" || !pageToken.length || tokens.has(pageToken)) throw new TypeError("order-fill-pagination-did-not-advance");
    tokens.add(pageToken);
  }
  return { id: receipts.at(-1), status: 200, payload: rows, pageReceipts: receipts, complete: false };
}
