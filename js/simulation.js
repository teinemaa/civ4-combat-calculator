// Stack vs Stack Monte Carlo simulation
// Attacker selection matches Civ4 source: CvSelectionGroup::groupAttack()
// Uses AI_getBestGroupAttacker + AI_getBestGroupSacrifice (68% threshold)

import {
  simulateSingleCombat, applyCollateralDamage, calculateEffectiveStrength,
  getEffectiveFirstStrikes, getEffectiveWithdrawalChance, isUnitImmuneToFirstStrikes,
} from './combat.js';
import { COMBAT_GLOBALS } from './data.js';

// ── Defender Selection ─────────────────────────────────────────────────

/**
 * Select the best defender from the stack against a given attacker.
 * Civ4: CvPlot::getBestDefender — picks the defender with highest
 * effective defense strength (HP-adjusted) vs this attacker.
 */
function selectBestDefender(attacker, defenderStack, context) {
  let bestIndex = -1;
  let bestScore = -1;

  for (let i = 0; i < defenderStack.length; i++) {
    if (defenderStack[i].hp <= 0) continue;

    const dStr = calculateEffectiveStrength(defenderStack[i], attacker, {
      ...context,
      isAttacker: false,
    }) * defenderStack[i].hp / COMBAT_GLOBALS.maxHP;
    const aStr = calculateEffectiveStrength(attacker, defenderStack[i], {
      ...context,
      isAttacker: true,
    }) * attacker.hp / COMBAT_GLOBALS.maxHP;

    const score = dStr / (aStr + dStr);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex;
}

// ── AI Attack Odds (CvUnitAI::AI_attackOdds) ───────────────────────────

/**
 * AI's approximation of attack odds (1–99).
 *
 * From CvUnitAI.cpp: uses currCombatStr(NULL, NULL) for attacker (raw
 * base strength, no modifiers) and currCombatStr(pPlot, this) for
 * defender (full defensive modifiers). This is deliberately simplified —
 * the AI doesn't account for attacker bonuses in its heuristic.
 */
function aiAttackOdds(attacker, defenderStack, context) {
  const dIdx = selectBestDefender(attacker, defenderStack, context);
  if (dIdx === -1) return 100;
  const defender = defenderStack[dIdx];

  // Attacker: currCombatStr(NULL, NULL) — raw base strength, no modifiers
  let ourStr = Math.floor(attacker.strength * 100 * attacker.hp / COMBAT_GLOBALS.maxHP);
  const ourMaxStr = attacker.strength * 100;
  const ourFP = Math.floor((ourMaxStr + ourStr + 1) / 2);

  if (ourStr === 0) return 1;

  // Defender: currCombatStr(pPlot, this) — full defensive modifiers
  const dEffStr = calculateEffectiveStrength(defender, attacker, {
    ...context,
    isAttacker: false,
  });
  let theirStr = Math.floor(dEffStr * 100 * defender.hp / COMBAT_GLOBALS.maxHP);
  const theirMaxStr = Math.floor(dEffStr * 100);
  const theirFP = Math.floor((theirMaxStr + theirStr + 1) / 2);

  const baseOdds = Math.floor(100 * ourStr / (ourStr + theirStr));
  if (baseOdds === 0) return 1;

  // Damage calculations
  const sf = Math.floor((ourFP + theirFP + 1) / 2);
  const dmgToUs = Math.max(1, Math.floor(20 * (theirFP + sf) / (ourFP + sf)));
  const dmgToThem = Math.max(1, Math.floor(20 * (ourFP + sf) / (theirFP + sf)));

  // Rounds needed
  const hitLimitThem = COMBAT_GLOBALS.maxHP - (attacker.combatLimit || 100);
  let neededRoundsUs = Math.ceil(Math.max(0, defender.hp - hitLimitThem) / dmgToThem);
  let neededRoundsThem = Math.ceil(attacker.hp / dmgToUs);

  // First strike adjustment (CvUnitAI::AI_attackOdds)
  // Uses average first strikes: guaranteed + floor(chances / 2)
  const aFSInfo = getEffectiveFirstStrikes(attacker);
  let attackerFS = aFSInfo.guaranteed + Math.floor(aFSInfo.chances / 2);
  const dFSInfo = getEffectiveFirstStrikes(defender);
  let defenderFS = dFSInfo.guaranteed + Math.floor(dFSInfo.chances / 2);

  // Immunity nullifies opponent's first strikes
  if (isUnitImmuneToFirstStrikes(defender)) attackerFS = 0;
  if (isUnitImmuneToFirstStrikes(attacker)) defenderFS = 0;

  neededRoundsUs -= Math.floor((baseOdds * attackerFS + 50) / 100);
  neededRoundsThem -= Math.floor(((100 - baseOdds) * defenderFS + 50) / 100);

  neededRoundsUs = Math.max(1, neededRoundsUs);
  neededRoundsThem = Math.max(1, neededRoundsThem);

  // Adjust strength by rounds difference
  const roundsDiff = neededRoundsUs - neededRoundsThem;
  if (roundsDiff > 0) {
    theirStr *= (1 + roundsDiff);
  } else {
    ourStr *= (1 - roundsDiff);
  }

  let odds = Math.floor(ourStr * 100 / (ourStr + theirStr));
  odds += Math.floor((100 - odds) * getEffectiveWithdrawalChance(attacker) / 100);

  return Math.max(1, Math.min(odds, 99));
}

// ── AI Sacrifice Value (CvUnitAI::AI_sacrificeValue) ───────────────────

/**
 * Sacrifice value: higher = more expendable = sent first when odds < 68%.
 *
 * From CvUnitAI.cpp: considers effective strength, collateral potential,
 * city defense value, withdrawal, production cost, experience, and
 * combat limit (siege units get 1.5x).
 */
function aiSacrificeValue(attacker, defenderStack, context) {
  const dIdx = selectBestDefender(attacker, defenderStack, context);
  const defender = dIdx >= 0 ? defenderStack[dIdx] : null;

  // currEffectiveStr: attacker's full effective strength (with attack modifiers)
  const effStr = defender
    ? calculateEffectiveStrength(attacker, defender, { ...context, isAttacker: true })
    : attacker.strength;
  const currEffStr = Math.floor(effStr * 100 * attacker.hp / COMBAT_GLOBALS.maxHP);

  // Collateral damage value
  let collateralValue = 0;
  const numDefenders = defenderStack.filter(d => d.hp > 0).length;
  const possibleTargets = Math.min(
    numDefenders - 1,
    attacker.collateralDamageMaxUnits || 0
  );
  if (possibleTargets > 0 && (attacker.collateralDamage || 0) > 0) {
    collateralValue = attacker.collateralDamage;
    collateralValue += Math.max(0, collateralValue - 100);
    collateralValue = Math.floor(collateralValue * possibleTargets / 5);
  }

  // City defense modifier (from unit + promotions)
  let cityDefMod = attacker.cityDefenseBonus || 0;
  if (attacker.promotions) {
    for (const p of attacker.promotions) {
      if (p.cityDefensePercent) cityDefMod += p.cityDefensePercent;
    }
  }

  let value = 128 * currEffStr;
  value = Math.floor(value * (100 + collateralValue) / (100 + cityDefMod));
  value = Math.floor(value * (100 + getEffectiveWithdrawalChance(attacker)));
  value = Math.floor(value / Math.max(1, 1 + (attacker.cost || 0)));
  value = Math.floor(value / (10 + (attacker.experience || 0)));

  // Siege units (combatLimit < 100) are preferred sacrifices
  if ((attacker.combatLimit || 100) < 100) {
    value = Math.floor(value * 150 / 100);
  }

  return value;
}

// ── Attacker Selection (CvSelectionGroup::groupAttack) ─────────────────

/**
 * Select best attacker using Civ4's two-phase algorithm:
 * 1. AI_getBestGroupAttacker: highest AI_attackOdds (+ collateral boost)
 * 2. If best raw odds < 68%: switch to AI_getBestGroupSacrifice
 *
 * This is recalculated after each combat (defender state may change).
 */
function selectGroupAttacker(attackerStack, defenderStack, context, attacked) {
  let bestIndex = -1;
  let bestValue = 0;
  let bestOdds = 0;

  const numDefenders = defenderStack.filter(d => d.hp > 0).length;
  if (numDefenders === 0) return -1;

  // Phase 1: AI_getBestGroupAttacker
  for (let i = 0; i < attackerStack.length; i++) {
    if (attackerStack[i].hp <= 0) continue;
    if (attacked.has(i)) continue;

    const odds = aiAttackOdds(attackerStack[i], defenderStack, context);
    let value = odds;

    // Collateral damage boost to selection value
    const collDmg = attackerStack[i].collateralDamage || 0;
    if (collDmg > 0) {
      const targets = Math.min(
        numDefenders - 1,
        attackerStack[i].collateralDamageMaxUnits || 0
      );
      if (targets > 0) {
        value = Math.floor(value * (100 + Math.floor(collDmg * targets / 5)) / 100);
      }
    }

    // For human player: first unit with highest value (strict >)
    if (value > bestValue) {
      bestValue = value;
      bestOdds = odds;
      bestIndex = i;
    }
  }

  // Phase 2: if best raw odds < 68%, use sacrifice logic
  if (bestOdds < 68 && bestIndex !== -1) {
    const sacrificeIdx = selectBestSacrifice(
      attackerStack, defenderStack, context, attacked
    );
    if (sacrificeIdx !== -1) {
      return sacrificeIdx;
    }
  }

  return bestIndex;
}

/**
 * AI_getBestGroupSacrifice: picks the most expendable unit.
 * Uses >= for comparison (picks LAST unit with highest value).
 */
function selectBestSacrifice(attackerStack, defenderStack, context, attacked) {
  let bestIndex = -1;
  let bestValue = 0;

  for (let i = 0; i < attackerStack.length; i++) {
    if (attackerStack[i].hp <= 0) continue;
    if (attacked.has(i)) continue;

    const value = aiSacrificeValue(attackerStack[i], defenderStack, context);

    // Pick LAST unit with highest value (>=)
    if (value >= bestValue) {
      bestValue = value;
      bestIndex = i;
    }
  }

  return bestIndex;
}

// ── Stack Helpers ──────────────────────────────────────────────────────

function cloneStack(stack) {
  return stack.map(u => ({
    ...u,
    hp: u.hp ?? COMBAT_GLOBALS.maxHP,
    promotions: u.promotions ? [...u.promotions] : [],
  }));
}

/**
 * Run one attacker's single combat (one attack per turn).
 * After combat, apply collateral damage to the defender stack.
 */
function runAttackerCombat(attacker, defenders, context) {
  if (attacker.hp <= 0) return;

  const dIdx = selectBestDefender(attacker, defenders, context);
  if (dIdx === -1) return;

  const result = simulateSingleCombat(attacker, defenders[dIdx], context);
  attacker.hp = result.attackerHP;
  defenders[dIdx].hp = result.defenderHP;

  // Collateral damage: splash to other defenders after combat
  applyCollateralDamage(attacker, defenders, dIdx);
}

// ── Simulation ─────────────────────────────────────────────────────────

/**
 * Run a single full stack combat simulation.
 * In 'ordered' mode: attackers go in stack order.
 * In 'stack' mode: uses Civ4's groupAttack algorithm.
 */
function runSingleSimulation(attackerStack, defenderStack, context) {
  const attackers = cloneStack(attackerStack);
  const defenders = cloneStack(defenderStack);

  const attacked = new Set();
  const attackOrder = new Array(attackers.length).fill(attackers.length); // default: didn't attack
  let orderPos = 0;

  if (context.attackMode === 'stack') {
    // Stack mode: Civ4 groupAttack — recalculate after each combat
    for (let i = 0; i < attackers.length; i++) {
      const aIdx = selectGroupAttacker(attackers, defenders, context, attacked);
      if (aIdx === -1) break;
      attacked.add(aIdx);
      attackOrder[aIdx] = orderPos++;
      runAttackerCombat(attackers[aIdx], defenders, context);
      if (defenders.every(d => d.hp <= 0)) break;
    }
  } else {
    // Ordered mode: sequential
    for (let a = 0; a < attackers.length; a++) {
      if (attackers[a].hp <= 0) continue;
      attackOrder[a] = orderPos++;
      runAttackerCombat(attackers[a], defenders, context);
    }
  }

  return {
    attackersSurviving: attackers.filter(u => u.hp > 0).length,
    defendersSurviving: defenders.filter(u => u.hp > 0).length,
    attackerTotalHP: attackers.reduce((sum, u) => sum + Math.max(0, u.hp), 0),
    defenderTotalHP: defenders.reduce((sum, u) => sum + Math.max(0, u.hp), 0),
    attackerDetails: attackers.map((u, i) => ({ id: u.id, name: u.name, hp: Math.max(0, u.hp), order: attackOrder[i] })),
    defenderDetails: defenders.map(u => ({ id: u.id, name: u.name, hp: Math.max(0, u.hp) })),
  };
}

/**
 * Run Monte Carlo stack simulation.
 * Returns aggregated statistics.
 */
export function simulateStackCombat(attackerStack, defenderStack, context, numRuns = 1000) {
  if (attackerStack.length === 0 || defenderStack.length === 0) {
    return null;
  }

  const results = [];
  let attackerWins = 0;
  let defenderWins = 0;

  for (let i = 0; i < numRuns; i++) {
    const result = runSingleSimulation(attackerStack, defenderStack, context);
    results.push(result);

    if (result.defendersSurviving === 0) {
      attackerWins++;
    } else if (result.attackersSurviving === 0) {
      defenderWins++;
    }
  }

  // Aggregate
  const avgAttSurviving = results.reduce((s, r) => s + r.attackersSurviving, 0) / numRuns;
  const avgDefSurviving = results.reduce((s, r) => s + r.defendersSurviving, 0) / numRuns;
  const avgAttHP = results.reduce((s, r) => s + r.attackerTotalHP, 0) / numRuns;
  const avgDefHP = results.reduce((s, r) => s + r.defenderTotalHP, 0) / numRuns;

  // Per-unit survival rates
  const attackerSurvivalRates = attackerStack.map((_, idx) => {
    const survivedRuns = results.filter(r => r.attackerDetails[idx].hp > 0);
    const survived = survivedRuns.length;
    const avgHP = results.reduce((s, r) => s + r.attackerDetails[idx].hp, 0) / numRuns;
    const avgHPWhenSurvived = survived > 0
      ? survivedRuns.reduce((s, r) => s + r.attackerDetails[idx].hp, 0) / survived
      : 0;
    return { survivalRate: survived / numRuns, avgHP, avgHPWhenSurvived };
  });

  const defenderSurvivalRates = defenderStack.map((_, idx) => {
    const survivedRuns = results.filter(r => r.defenderDetails[idx].hp > 0);
    const survived = survivedRuns.length;
    const avgHP = results.reduce((s, r) => s + r.defenderDetails[idx].hp, 0) / numRuns;
    const avgHPWhenSurvived = survived > 0
      ? survivedRuns.reduce((s, r) => s + r.defenderDetails[idx].hp, 0) / survived
      : 0;
    return { survivalRate: survived / numRuns, avgHP, avgHPWhenSurvived };
  });

  // Average attack order per unit, then normalize to ranks 1,2,3...
  const avgAttackOrder = attackerStack.map((_, idx) => {
    return results.reduce((s, r) => s + r.attackerDetails[idx].order, 0) / numRuns;
  });
  const sorted = avgAttackOrder.map((avg, idx) => ({ avg, idx })).sort((a, b) => a.avg - b.avg);
  const attackerOrderRanks = new Array(attackerStack.length);
  sorted.forEach((item, rank) => {
    attackerOrderRanks[item.idx] = rank + 1;
  });

  return {
    numRuns,
    attackerWinRate: attackerWins / numRuns,
    defenderWinRate: defenderWins / numRuns,
    drawRate: (numRuns - attackerWins - defenderWins) / numRuns,
    avgAttackersSurviving: avgAttSurviving,
    avgDefendersSurviving: avgDefSurviving,
    avgAttackerTotalHP: avgAttHP,
    avgDefenderTotalHP: avgDefHP,
    attackerSurvivalRates,
    defenderSurvivalRates,
    attackerOrderRanks,
  };
}
