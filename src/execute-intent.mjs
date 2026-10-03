import { createHash } from "node:crypto";
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
export function assessCurrentExecutionCapacity({ contract, intent, accountReceipt, positionsReceipt }) {
  if (!successfulReceipt(accountReceipt) || !successfulReceipt(positionsReceipt)) throw new TypeError("pretrade-broker-observation-refused");
  const account = accountReceipt.payload;
  const positions = positionsReceipt.payload;
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
  let postTradeSymbolValue;
  if (intent.side === "buy") {
    if (notional > buyingPower) throw new RangeError("insufficient-current-buying-power");
    postTradeSymbolValue = currentSymbolValue + notional;
  } else {
    if (contract.risk.shorting !== true && currentSymbolValue < notional) throw new RangeError("sell-would-create-unapproved-short-position");
    postTradeSymbolValue = currentSymbolValue - notional;
  }
  const otherExposure = positionValues.filter(({ symbol }) => symbol !== normalizedSymbol).reduce((sum, position) => sum + Math.abs(position.value), 0);
  const aggregateNotional = otherExposure + Math.abs(postTradeSymbolValue);
  if (aggregateNotional > maximumAggregateNotional) throw new RangeError("current-aggregate-exposure-limit-exceeded");
  const concentration = Math.abs(postTradeSymbolValue) / equity;
  if (concentration > concentrationLimit) throw new RangeError("current-concentration-limit-exceeded");
  return Object.freeze({ equity, buyingPower, currentAggregateNotional: otherExposure + Math.abs(currentSymbolValue), aggregateNotional, postTradeSymbolNotional: Math.abs(postTradeSymbolValue), concentration, maximumAggregateNotional, concentrationLimit });
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
  if (typeof resolveExecutionRecords !== "function" || !["readAccount", "listPositions", "getOrderByClientOrderId", "placeOrder", "listActivities"].every((method) => typeof adapter?.[method] === "function")) throw new TypeError(`${mode}-execution-resolver-and-adapter-required`);
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
    let preTradeAccount = null, preTradePositions = null, capacity = null;
    if (!order) {
      const second = await resolve(request); // exact active authority immediately before the sole venue effect
      [preTradeAccount, preTradePositions] = await Promise.all([
        adapter.readAccount({ grant: second.records.authorityGrant, now: second.now }),
        adapter.listPositions({ grant: second.records.authorityGrant, now: second.now }),
      ]);
      capacity = assessCurrentExecutionCapacity({ contract: second.records.contract, intent: second.records.intent, accountReceipt: preTradeAccount, positionsReceipt: preTradePositions });
      try { placement = await adapter.placeOrder({ grant: second.records.authorityGrant, order: { symbol: second.records.intent.symbol, side: second.records.intent.side, notional: second.records.intent.notional, type: "market", time_in_force: "day", client_order_id: clientOrderId }, operationAuthorizationReference: second.records.intent.id, now: second.now }); }
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
    return Object.freeze(identify({ type: receiptType, version: 1, contract: observationAuthority.records.contract.id, authorityGrant: observationAuthority.records.authorityGrant.id, intent: observationAuthority.records.intent.id, clientOrderId, idempotent, placementReceipt: placement?.id ?? null, placementStatus: placement?.status ?? null, orderReceipt: order.id, orderVenueStatus: order.payload.status, preTradeAccountReceipt: preTradeAccount?.id ?? null, preTradePositionsReceipt: preTradePositions?.id ?? null, executionCapacity: capacity, accountReceipt: observations[0].status === "fulfilled" ? observations[0].value.id : null, positionsReceipt: observations[1].status === "fulfilled" ? observations[1].value.id : null, activitiesReceipt: observations[2].status === "fulfilled" ? observations[2].value.id : null, observationsComplete: complete, activityCorrelationClaimed: false, orderObservationDisposition: terminal ? "terminal-order-observed" : "pending", accountReconciliationDisposition: "pending", pendingReason: terminal ? "account-content-not-correlated" : "order-nonterminal", observedAt: observationAuthority.now, strategySelectedByTransport: false, credentialsExported: false, liveVenueEffect }));
  };
  const provider = async (request) => {
    const references = { contract: { id: reference(request?.contractReference, "contract-reference") }, intent: { id: reference(request?.intentReference, "intent-reference") } };
    reference(request?.authorityGrantReference, "authority-grant-reference");
    const clientOrderId = clientOrderIdFor(mode, references), prior = locks.get(clientOrderId) ?? Promise.resolve();
    let release; const held = new Promise((resolveHeld) => { release = resolveHeld; }); const chain = prior.then(() => held); locks.set(clientOrderId, chain);
    await prior;
    try { return await executeLocked(request); }
    finally { release(); if (locks.get(clientOrderId) === chain) locks.delete(clientOrderId); }
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
