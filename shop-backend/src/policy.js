import { MAX_DISCOUNT_PCT } from './config.js';
/**
 * Runs every guardrail check for a proposed order and returns a structured
 * list, so the audit log can show exactly which gate passed/failed and why.
 * Nothing here throws - the caller decides what to do with a failed check.
 */
export function runPolicyChecks({ session, items, productsById, totalAmount, discountPct = 0 }) {
  const checks = [];

  checks.push({
    name: 'session_valid',
    passed: !!session,
    reason: session ? 'Session found' : 'No such session'
  });
  if (!session) return checks;

  // Every referenced product ID must actually exist - catches a hallucinated
  // SKU from the agent with a clear reason, instead of a confusing stock error.
  const unknownIds = items.filter(it => !productsById[it.product_id]).map(it => it.product_id);
  checks.push({
    name: 'valid_product_ids',
    passed: unknownIds.length === 0,
    reason: unknownIds.length === 0
      ? 'All referenced product IDs exist in the catalog'
      : `Unknown product ID(s): ${unknownIds.join(', ')} - not found in catalog`
  });
  if (unknownIds.length > 0) return checks; // no point checking further against missing data

  const remaining = session.budget_limit - session.spent;
  const withinBudget = totalAmount <= remaining;
  checks.push({
    name: 'budget_cap',
    passed: withinBudget,
    reason: withinBudget
      ? `Order ₹${(totalAmount/100).toFixed(2)} within remaining budget ₹${(remaining/100).toFixed(2)}`
      : `Order ₹${(totalAmount/100).toFixed(2)} exceeds remaining budget ₹${(remaining/100).toFixed(2)}`
  });

  const allowedCategories = session.allowed_categories ? JSON.parse(session.allowed_categories) : null;
  if (allowedCategories) {
    const badItem = items.find(it => !allowedCategories.includes(productsById[it.product_id]?.category));
    checks.push({
      name: 'category_allowlist',
      passed: !badItem,
      reason: badItem
        ? `Category '${productsById[badItem.product_id]?.category}' not in allowed list [${allowedCategories.join(', ')}]`
        : `All items within allowed categories [${allowedCategories.join(', ')}]`
    });
  }

  if (session.actor_type === 'agent') {
    const blockedItem = items.find(it => productsById[it.product_id]?.agent_purchasable !== 1);//0/1 integer column, with integer default 1 for sqlite
    checks.push({
      name: 'sku_agent_purchasable',
      passed: !blockedItem,
      reason: blockedItem
        ? `Product '${blockedItem.product_id}' is not marked agent-purchasable (human checkout only)`
        : 'All items are agent-purchasable SKUs'
    });

    const overPriced = items.find(it => {
      const p = productsById[it.product_id];
      return p?.max_agent_price != null && p.price > p.max_agent_price;
    });
    checks.push({
      name: 'per_sku_price_cap',
      passed: !overPriced,
      reason: overPriced
        ? `Product '${overPriced.product_id}' price exceeds its agent price cap`
        : 'All items within per-SKU agent price caps'
    });
  
  if (discountPct > 0) {
      const withinLimit = discountPct <= MAX_DISCOUNT_PCT;
      checks.push({
        name: 'discount_within_limit',
        passed: withinLimit,
        reason: withinLimit
          ? `Discount ${discountPct}% is within the merchant's ${MAX_DISCOUNT_PCT}% limit`
          : `Discount ${discountPct}% exceeds the merchant's ${MAX_DISCOUNT_PCT}% limit`
      });
    }
  }

  const outOfStock = items.find(it => (productsById[it.product_id]?.stock ?? 0) < it.qty);
  checks.push({
    name: 'stock_available',
    passed: !outOfStock,
    reason: outOfStock
      ? `Insufficient stock for '${outOfStock.product_id}' (requested ${outOfStock.qty}, available ${productsById[outOfStock.product_id]?.stock ?? 0})`
      : 'All items in stock'
  });

  return checks;
}

export function needsConfirmation(session, totalAmount) {
  if (session.confirmation_threshold == null) return false;
  return totalAmount > session.confirmation_threshold;
}

export function allChecksPassed(checks) {
  return checks.every(c => c.passed);
}