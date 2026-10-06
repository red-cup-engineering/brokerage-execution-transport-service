import { createHash } from "node:crypto";
import { allocationFor, allocationsFor } from '@red-cup-engineering/mandate-portfolio-allocation-service/market-game';
import { verifySignedRecord } from "@red-cup-engineering/strategy-evaluation-service";
import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/computer-content-engineering-services-section/semantic-content-identity";

const identify = (body) => ({ id: identifyJsonSemanticContent({
  objectKind: "brokerage.execution-transport.record",
  value: body,
  witnessRoot: EMPTY_WITNESS_ROOT,
}).id, ...body });
export function validateExecutionRequest({ contract, authorityGrant, intent, revocation, now = new Date().toISOString() }) {
  if (!Number.isFinite(Date.parse(now))) throw new TypeError("execution-time-required");
  if (contract?.type !== "PrincipalBrokerageServiceContract" || intent?.type !== "AggressiveBrokerageOrderIntent" || intent.contract !== contract.id) throw new TypeError("contract-bound-intent-required");
  if (authorityGrant?.type !== "RevocableBrokerageAuthorityGrant" || authorityGrant.revoked !== false || revocation?.effective === true
    || !contract.scopes.includes("orders:live") || !authorityGrant.scopes?.includes("orders:live") || authorityGrant.principalContract !== contract.id) throw new TypeError("live-order-authority-refused");
  if (Date.parse(now) >= Date.parse(contract.validUntil) || Date.parse(now) >= Date.parse(authorityGrant.validUntil)) throw new TypeError("live-order-authority-expired");
  if (intent.notional > contract.risk.maximumOrderNotional || intent.maximumLoss > contract.risk.maximumLossAmount) throw new RangeError("execution-limit-exceeded");
  if (intent.marketDecision && (intent.side !== 'buy' || Math.ceil(intent.notional * 100 - 1e-9) > allocationFor(intent.marketDecision, { venue: 'alpaca', instrument: intent.symbol, side: 'long', at: now }))) throw new RangeError('shared-market-allocation-expired-or-exceeded');
  return Object.freeze({ contract, authorityGrant, intent, revocation: revocation ?? null, now });
}
export async function executeAdmittedIntent({ contract, authorityGrant, intent, revocation, adapter, now = new Date().toISOString() }) {
  validateExecutionRequest({ contract, authorityGrant, intent, revocation, now });
  // This predecessor could place a live order without observing current account
  // capital or positions.  Keeping it callable would leave a second, weaker
  // effect path beside the reconciled providers below.
  void adapter;
  throw new TypeError("unreconciled-execution-transport-retired-use-mode-specific-provider");
}

const reference = (value, label) => { if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label}-required`); return value; };
/** Shared-game orders use their modeled entry ceiling and funded quantity.
 * This is invoked only for a NEW placement; older filled orders can still be
 * reconciled after their research decision expires. */
export function venueOrderForIntent(intent, now, clientOrderId) {
  const base = { symbol: intent.symbol, side: intent.side, time_in_force: 'day', client_order_id: clientOrderId };
  if (!intent.marketDecision) return { ...base, notional: intent.notional, type: 'market' };
  const funded = allocationsFor(intent.marketDecision, { venue: 'alpaca', instrument: intent.symbol, side: 'long', at: now });
  if (intent.side !== 'buy' || funded.length !== 1 || Math.ceil(intent.notional * 100 - 1e-9) > funded[0].capitalCents) throw new RangeError('shared-market-allocation-expired-or-exceeded');
  const q = funded[0]; const units = Math.min(q.units, Math.floor(intent.notional / q.entryPrice / q.unitStep + 1e-10) * q.unitStep);
  if (!(units >= q.unitStep)) throw new RangeError('shared-market-order-below-funded-lot');
  return { ...base, time_in_force: q.assetClass === 'crypto' ? 'ioc' : 'day', qty: (Math.floor(units * 1e9 + 1e-6) / 1e9).toFixed(9), type: 'limit', limit_price: String(q.entryPrice) };
}
export function createExecutionTransportProvider({ resolveExecutionRecords, adapter, clock = () => new Date().toISOString() }) {
  void resolveExecutionRecords;
  void adapter;
  void clock;
  throw new TypeError("unreconciled-execution-transport-retired-use-paper-or-live-reconciliation-provider");
}

const clientOrderIdFor = (mode, { contract, intent }) => `${mode}-${createHash("sha256").update(`${contract.id}:${intent.id}`).digest("hex").slice(0, 48)}`;

const successfulReceipt = (receipt) => Number.isInteger(receipt?.status) && receipt.status >= 200 && receipt.status < 300;
const money = (value, label) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`${label}-invalid`);
  return amount;
};
const marketValue = (position) => {
  const amount = Number(position?.market_value ?? position?.marketValue);
  if (!Number.isFinite(amount)) throw new TypeError("position-market-value-invalid");
  return amount;
};

/**
 * Admit one new venue effect from observations made immediately before it.
 *
 * This deliberately does not compare equity with a persisted high-water mark:
 * a transfer, account reset, or broker correction is not evidence of a loss.
 * The enforceable facts are the broker's current equity, buying power, and
 * already-open exposure against the contract the principal actually granted.
 */
export function assessCurrentExecutionCapacity({ contract, intent, accountReceipt, positionsReceipt, openOrdersReceipt }) {
  if (!successfulReceipt(accountReceipt) || !successfulReceipt(positionsReceipt) || !successfulReceipt(openOrdersReceipt)) throw new TypeError("pretrade-broker-observation-refused");
  const account = accountReceipt.payload;
  const positions = positionsReceipt.payload;
  const openOrders = openOrdersReceipt.payload;
  if (!Array.isArray(openOrders) || openOrders.length >= 500) throw new TypeError("complete-bounded-open-orders-required");
  if (!account || typeof account !== "object" || !Array.isArray(positions)) throw new TypeError("pretrade-broker-payload-invalid");
  if (String(account.status ?? "").toUpperCase() !== "ACTIVE" || account.trading_blocked === true || account.account_blocked === true) throw new TypeError("brokerage-account-not-tradable");
  if (String(account.currency ?? "").toUpperCase() !== String(contract?.capital?.currency ?? "").toUpperCase()) throw new TypeError("account-and-contract-currency-mismatch");
  const equity = money(account.equity, "account-equity");
  const buyingPower = money(account.buying_power ?? account.buyingPower ?? account.cash, "account-buying-power");
  if (equity === 0) throw new RangeError("account-equity-empty");
  const notional = money(intent?.notional, "intent-notional");
  if (notional === 0) throw new RangeError("intent-notional-empty");
  const maximumAggregateNotional = money(contract?.risk?.maximumAggregateNotional, "contract-maximum-aggregate-notional");
  const concentrationLimit = Number(contract?.risk?.concentrationLimit);
  if (!Number.isFinite(concentrationLimit) || concentrationLimit <= 0 || concentrationLimit > 1) throw new TypeError("contract-concentration-limit-invalid");
  if (!['buy', 'sell'].includes(intent?.side)) throw new TypeError("intent-side-invalid");
  const normalizedSymbol = String(intent.symbol ?? "").toUpperCase();
  if (!normalizedSymbol) throw new TypeError("intent-symbol-required");
  const positionValues = positions.map((position) => ({ symbol: String(position?.symbol ?? "").toUpperCase(), value: marketValue(position) }));
  if (positionValues.some(({ symbol }) => !symbol)) throw new TypeError("position-symbol-invalid");
  const currentSymbolValue = positionValues.filter(({ symbol }) => symbol === normalizedSymbol).reduce((sum, position) => sum + position.value, 0);
  const exposure = new Map();
  for (const p of positionValues) {
    const range = exposure.get(p.symbol) ?? { held: 0, buys: 0, sells: 0 };
    range.held += p.value; exposure.set(p.symbol, range);
  }
  for (const order of openOrders) {
    const symbol = String(order.symbol ?? '').toUpperCase();
    if (!symbol || !['buy', 'sell'].includes(order.side)) throw new TypeError('open-order-symbol-and-side-required');
    let reserved;
    if (order.notional != null) reserved = money(order.notional, 'open-order-notional');
    else {
      const quantity = money(order.qty, 'open-order-quantity');
      const filled = money(order.filled_qty ?? 0, 'open-order-filled-quantity');
      if (filled > quantity || order.type !== 'limit' || order.limit_price == null) throw new TypeError('bounded-open-order-price-required');
      reserved = (quantity - filled) * money(order.limit_price, 'open-order-limit-price');
    }
    const range = exposure.get(symbol) ?? { held: 0, buys: 0, sells: 0 };
    range[order.side === 'buy' ? 'buys' : 'sells'] += reserved; exposure.set(symbol, range);
  }
  const range = exposure.get(normalizedSymbol) ?? { held: 0, buys: 0, sells: 0 };
  if (intent.side === 'buy' && notional > buyingPower) throw new RangeError('insufficient-current-buying-power');
  if (intent.side === 'sell' && contract.risk.shorting !== true && range.held < range.sells + notional) throw new RangeError('sell-would-create-unapproved-short-position');
  const worstExposure = r => Math.max(Math.abs(r.held - r.sells), Math.abs(r.held + r.buys));
  const currentAggregateNotional = [...exposure.values()].reduce((sum, r) => sum + worstExposure(r), 0);
  range[intent.side === 'buy' ? 'buys' : 'sells'] += notional; exposure.set(normalizedSymbol, range);
  const aggregateNotional = [...exposure.values()].reduce((sum, r) => sum + worstExposure(r), 0);
  const postTradeSymbolValue = worstExposure(range);
  if (aggregateNotional > maximumAggregateNotional) throw new RangeError("current-aggregate-exposure-limit-exceeded");
  const concentration = Math.abs(postTradeSymbolValue) / equity;
  if (concentration > concentrationLimit) throw new RangeError("current-concentration-limit-exceeded");
  return Object.freeze({ openOrdersReceipt: openOrdersReceipt.id, equity, buyingPower, currentAggregateNotional, aggregateNotional, postTradeSymbolNotional: Math.abs(postTradeSymbolValue), concentration, maximumAggregateNotional, concentrationLimit });
}

function validateExecution(mode, { contract, authorityGrant, intent, revocation, now, trustedPromotionActorKeys }) {
  if (contract?.type !== "PrincipalBrokerageServiceContract" || intent?.type !== "AggressiveBrokerageOrderIntent" || intent.contract !== contract.id) throw new TypeError(`contract-bound-${mode}-intent-required`);
  if (contract.venue !== `alpaca-trading-${mode}` || authorityGrant?.type !== "RevocableBrokerageAuthorityGrant" || authorityGrant.adapter !== `alpaca-trading-${mode}` || authorityGrant.revoked !== false || revocation?.effective === true || authorityGrant.principalContract !== contract.id) throw new TypeError(`${mode}-order-authority-refused`);
  const required = ["account:read", "positions:read", "orders:read", `orders:${mode}`, "activities:read"];
  if (required.some((scope) => !contract.scopes?.includes(scope) || !authorityGrant.scopes?.includes(scope))) throw new TypeError(`${mode}-order-scope-refused`);
  const executionTime = Date.parse(now), contractExpiry = Date.parse(contract.validUntil), grantExpiry = Date.parse(authorityGrant.validUntil);
  if (![executionTime, contractExpiry, grantExpiry].every(Number.isFinite)) throw new TypeError(`${mode}-order-authority-time-invalid`);
  if (executionTime >= contractExpiry || executionTime >= grantExpiry) throw new TypeError(`${mode}-order-authority-expired`);
  if (intent.notional > contract.risk.maximumOrderNotional || intent.maximumLoss > contract.risk.maximumLossAmount) throw new RangeError(`${mode}-execution-limit-exceeded`);
  // The obsmetrologia paper-promotion certificate names a paper-only scope; gating on mode
  // keeps a live contract that (erroneously) carried this scope from being evaluated against it,
  // matching the historical behavior where live execution never referenced promotion certificates.
  if (mode === "paper" && contract.scopes.includes("strategy:obsmetrologia-paper-promotion")) {
    const certificate = verifySignedRecord(intent.promotionCertificate, "ObsmetrologiaPaperPromotionCertificate", "promotionActor", trustedPromotionActorKeys, "obsmetrologia-promotion");
    if (certificate.id !== intent.promotionCertificate.id || certificate.candidate !== intent.strategyCandidate || certificate.paperPromotionEstablished !== true || certificate.liveReadinessEstablished !== false) throw new TypeError("obsmetrologia-paper-promotion-invalid");
  }
}
const TERMINAL_ORDER_STATUSES = new Set(["filled", "canceled", "expired", "rejected"]);
function correlatedOrder(receipt, clientOrderId, phase) {
  if (receipt?.status === 404) return null;
  if (!Number.isInteger(receipt?.status) || receipt.status < 200 || receipt.status >= 300) throw new TypeError(`${phase}-order-lookup-refused`);
  if (receipt.payload?.client_order_id !== clientOrderId) throw new TypeError(`${phase}-order-client-id-mismatch`);
  return receipt;
}
function createExecutionAndReconciliationProvider(mode, { resolveExecutionRecords, adapter, trustedPromotionActorKeys = {}, clock = () => new Date().toISOString() }) {
  if (typeof resolveExecutionRecords !== "function" || !["readAccount", "listPositions", "listOpenOrders", "getOrderByClientOrderId", "placeOrder", "listActivities"].every((method) => typeof adapter?.[method] === "function")) throw new TypeError(`${mode}-execution-resolver-and-adapter-required`);
  const locks = new Map();
  const resolve = async (request) => {
    const references = Object.freeze({ contractReference: reference(request?.contractReference, "contract-reference"), authorityGrantReference: reference(request?.authorityGrantReference, "authority-grant-reference"), intentReference: reference(request?.intentReference, "intent-reference") });
    const records = await resolveExecutionRecords(references);
    if (records?.contract?.id !== references.contractReference || records?.authorityGrant?.id !== references.authorityGrantReference || records?.intent?.id !== references.intentReference) throw new TypeError(`${mode}-execution-resolved-record-reference-mismatch`);
    const now = clock(); validateExecution(mode, { ...records, now, trustedPromotionActorKeys }); return { references, records, now };
  };
  const receiptType = `Alpaca${mode[0].toUpperCase()}${mode.slice(1)}ExecutionAndReconciliationReceipt`;
  const liveVenueEffect = mode === "live";
  const pending = ({ records, now, clientOrderId, placement, reason, order = null, idempotent = false, preTradeAccountReceipt = null, preTradePositionsReceipt = null, capacity = null }) => Object.freeze(identify({ type: receiptType, version: 1, contract: records.contract.id, authorityGrant: records.authorityGrant.id, intent: records.intent.id, clientOrderId, idempotent, placementReceipt: placement?.id ?? null, placementStatus: placement?.status ?? null, orderReceipt: order?.id ?? null, orderVenueStatus: order?.payload?.status ?? null, preTradeAccountReceipt, preTradePositionsReceipt, executionCapacity: capacity, accountReceipt: null, positionsReceipt: null, activitiesReceipt: null, observationsComplete: false, activityCorrelationClaimed: false, orderObservationDisposition: "pending", accountReconciliationDisposition: "pending", pendingReason: reason, observedAt: now, strategySelectedByTransport: false, credentialsExported: false, liveVenueEffect }));
  const executeLocked = async (request) => {
    const first = await resolve(request), clientOrderId = clientOrderIdFor(mode, first.records);
    const initialReceipt = await adapter.getOrderByClientOrderId({ grant: first.records.authorityGrant, clientOrderId, now: first.now });
    let order = correlatedOrder(initialReceipt, clientOrderId, "initial"), placement = null, idempotent = Boolean(order);
    let preTradeAccount = null, preTradePositions = null, preTradeOpenOrders = null, capacity = null;
    if (!order) {
      const second = await resolve(request); // exact active authority immediately before the sole venue effect
      [preTradeAccount, preTradePositions, preTradeOpenOrders] = await Promise.all([
        adapter.readAccount({ grant: second.records.authorityGrant, now: second.now }),
        adapter.listPositions({ grant: second.records.authorityGrant, now: second.now }),
        adapter.listOpenOrders({ grant: second.records.authorityGrant, now: second.now }),
      ]);
      if (preTradeAccount.payload?.id !== second.records.authorityGrant.accountReference || second.records.contract.accountReference !== second.records.authorityGrant.accountReference) throw new TypeError("pretrade-account-authority-binding-mismatch");
      capacity = assessCurrentExecutionCapacity({ contract: second.records.contract, intent: second.records.intent, accountReceipt: preTradeAccount, positionsReceipt: preTradePositions, openOrdersReceipt: preTradeOpenOrders });
      const venueOrder = venueOrderForIntent(second.records.intent, second.now, clientOrderId);
      try { placement = await adapter.placeOrder({ grant: second.records.authorityGrant, order: venueOrder, operationAuthorizationReference: second.records.intent.id, now: second.now }); }
      catch { placement = null; }
      let post;
      try { post = await resolve(request); }
      catch { return pending({ records: second.records, now: second.now, clientOrderId, placement, reason: "post-effect-authority-unavailable", preTradeAccountReceipt: preTradeAccount.id, preTradePositionsReceipt: preTradePositions.id, capacity }); }
      let postReceipt;
      try { postReceipt = await adapter.getOrderByClientOrderId({ grant: post.records.authorityGrant, clientOrderId, now: post.now }); }
      catch { return pending({ records: post.records, now: post.now, clientOrderId, placement, reason: "post-order-lookup-unavailable", preTradeAccountReceipt: preTradeAccount.id, preTradePositionsReceipt: preTradePositions.id, capacity }); }
      if (postReceipt.status !== 404 && (!Number.isInteger(postReceipt.status) || postReceipt.status < 200 || postReceipt.status >= 300)) return pending({ records: post.records, now: post.now, clientOrderId, placement, reason: "post-order-lookup-refused", preTradeAccountReceipt: preTradeAccount.id, preTradePositionsReceipt: preTradePositions.id, capacity });
      order = correlatedOrder(postReceipt, clientOrderId, "post-effect");
      if (!order) return pending({ records: post.records, now: post.now, clientOrderId, placement, reason: "post-order-not-yet-observed", preTradeAccountReceipt: preTradeAccount.id, preTradePositionsReceipt: preTradePositions.id, capacity });
      first.records = post.records; first.now = post.now;
    }
    let observationAuthority;
    try { observationAuthority = await resolve(request); }
    catch { return pending({ records: first.records, now: first.now, clientOrderId, placement, order, idempotent, reason: "observation-authority-unavailable", preTradeAccountReceipt: preTradeAccount?.id ?? null, preTradePositionsReceipt: preTradePositions?.id ?? null, capacity }); }
    const observations = await Promise.allSettled([adapter.readAccount({ grant: observationAuthority.records.authorityGrant, now: observationAuthority.now }), adapter.listPositions({ grant: observationAuthority.records.authorityGrant, now: observationAuthority.now }), adapter.listActivities({ grant: observationAuthority.records.authorityGrant, now: observationAuthority.now })]);
    const complete = observations.every((result) => result.status === "fulfilled" && result.value.status >= 200 && result.value.status < 300);
    const terminal = TERMINAL_ORDER_STATUSES.has(String(order.payload?.status ?? "").toLowerCase());
    return Object.freeze(identify({ type: receiptType, version: 1, contract: observationAuthority.records.contract.id, authorityGrant: observationAuthority.records.authorityGrant.id, intent: observationAuthority.records.intent.id, clientOrderId, idempotent, placementReceipt: placement?.id ?? null, placementStatus: placement?.status ?? null, orderReceipt: order.id, orderVenueStatus: order.payload.status, preTradeAccountReceipt: preTradeAccount?.id ?? null, preTradePositionsReceipt: preTradePositions?.id ?? null, preTradeOpenOrdersReceipt: preTradeOpenOrders?.id ?? null, executionCapacity: capacity, accountReceipt: observations[0].status === "fulfilled" ? observations[0].value.id : null, positionsReceipt: observations[1].status === "fulfilled" ? observations[1].value.id : null, activitiesReceipt: observations[2].status === "fulfilled" ? observations[2].value.id : null, observationsComplete: complete, activityCorrelationClaimed: false, orderObservationDisposition: terminal ? "terminal-order-observed" : "pending", accountReconciliationDisposition: "pending", pendingReason: terminal ? "account-content-not-correlated" : "order-nonterminal", observedAt: observationAuthority.now, strategySelectedByTransport: false, credentialsExported: false, liveVenueEffect }));
  };
  const provider = async (request) => {
    const references = { contract: { id: reference(request?.contractReference, "contract-reference") }, intent: { id: reference(request?.intentReference, "intent-reference") } };
    reference(request?.authorityGrantReference, "authority-grant-reference");
    const current = await resolve(request);
    const accountKey = `${mode}:${reference(current.records.authorityGrant.accountReference, "account-reference")}`;
    const prior = locks.get(accountKey) ?? Promise.resolve();
    let release; const held = new Promise((resolveHeld) => { release = resolveHeld; }); const chain = prior.then(() => held); locks.set(accountKey, chain);
    await prior;
    try { return await executeLocked(request); }
    finally { release(); if (locks.get(accountKey) === chain) locks.delete(accountKey); }
  };
  Object.defineProperties(provider, { originatingActor: { value: "urn:ame:brokerage-execution-transport-service", enumerable: true }, preflight: { value: async (request) => { await resolve(request); }, enumerable: true }, externalEvidence: { value: (_request, output) => [{ uri: `urn:brokerage:${mode}-execution:${encodeURIComponent(output.clientOrderId)}`, digest: output.id }], enumerable: true } });
  return Object.freeze(provider);
}

export function createPaperExecutionAndReconciliationProvider({ resolvePaperExecutionRecords, adapter, trustedPromotionActorKeys = {}, clock = () => new Date().toISOString() }) {
  return createExecutionAndReconciliationProvider("paper", { resolveExecutionRecords: resolvePaperExecutionRecords, adapter, trustedPromotionActorKeys, clock });
}

export function createLiveExecutionAndReconciliationProvider({ resolveLiveExecutionRecords, adapter, clock = () => new Date().toISOString() }) {
  return createExecutionAndReconciliationProvider("live", { resolveExecutionRecords: resolveLiveExecutionRecords, adapter, clock });
}
