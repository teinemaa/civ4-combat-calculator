// Stack vs Stack Monte Carlo simulation
// Attacker selection matches Civ4 source: CvSelectionGroup::groupAttack()
// Uses AI_getBestGroupAttacker + AI_getBestGroupSacrifice (68% threshold)

import {
  simulateSingleCombat, applyCollateralDamage, applyFlankingStrikes,
  getEffectiveFirstStrikes, getEffectiveWithdrawalChance, isUnitImmuneToFirstStrikes,
  getAttackerBaseModifier, getCombinedDefenderModifier, maxCombatStrScaled,
} from './combat.js';
import { COMBAT_GLOBALS } from './data.js';

// ── Defender Selection ─────────────────────────────────────────────────

/**
 * Select the best defender from the stack against a given attacker.
 *
 * SDK: CvUnit::isBetterDefenderThan() (CvUnit.cpp line 1737-1897)
 * Picks the defender with the highest currCombatStr(plot, pAttacker),
 * adjusted for first strike value when an attacker is known.
 *
 * Simplified: we skip canCoexist, canDefend, world unit class,
 * and cargo checks since the calculator doesn't model those.
 * We do implement isTargetOf (unitCombatTargets) for units like Ballista Elephant.
 */
function selectBestDefender(attacker, defenderStack, context) {
  let bestIndex = -1;
  let bestScore = -1;
  let bestIsTarget = false;

  for (let i = 0; i < defenderStack.length; i++) {
    if (defenderStack[i].hp <= 0) continue;

    const defender = defenderStack[i];

    // SDK lines 1774-1783: isTargetOf check
    // If attacker has unitCombatTargets, defenders matching that type are always preferred
    const isTarget = attacker && attacker.unitCombatTargets
      ? attacker.unitCombatTargets.includes(defender.unitCombatType)
      : false;

    // SDK: if one is a target and the other isn't, the target wins regardless of score
    if (bestIndex !== -1) {
      if (isTarget && !bestIsTarget) {
        // This defender is a target, best isn't — this one wins automatically
      } else if (!isTarget && bestIsTarget) {
        // Best is a target, this one isn't — skip
        continue;
      }
    }

    // SDK line 1791: iOurDefense = currCombatStr(plot(), pAttacker)
    // This uses the combined defender modifier (defender bonuses + attacker tactical as negatives)
    const dMod = getCombinedDefenderModifier(attacker, defender, context);
    const dMaxStr = maxCombatStrScaled(defender.strength, dMod);
    let score = Math.trunc(dMaxStr * defender.hp / COMBAT_GLOBALS.maxHP);

    // SDK lines 1813-1823: First strike value adjustment when attacker is known
    // iOurDefense *= ((((firstStrikes() * 2) + chanceFirstStrikes()) * ((COMBAT_DAMAGE * 2) / 5)) + 100) / 100
    if (attacker) {
      const dFS = getEffectiveFirstStrikes(defender);
      const aFS = getEffectiveFirstStrikes(attacker);

      if (!isUnitImmuneToFirstStrikes(attacker)) {
        // Defender's first strikes boost its defense score
        const fsFactor = (dFS.guaranteed * 2 + dFS.chances) * Math.trunc(20 * 2 / 5);
        score = Math.trunc(score * (fsFactor + 100) / 100);
      }

      if (isUnitImmuneToFirstStrikes(defender)) {
        // Defender is immune to attacker's FS — boost (attacker FS can't hurt it)
        const fsFactor = (aFS.guaranteed * 2 + aFS.chances) * Math.trunc(20 * 2 / 5);
        score = Math.trunc(score * (fsFactor + 100) / 100);
      }
    }

    if (score > bestScore || (isTarget && !bestIsTarget)) {
      bestScore = score;
      bestIndex = i;
      bestIsTarget = isTarget;
    }
  }

  return bestIndex;
}

// ── AI Attack Odds (CvUnitAI::AI_attackOdds) ───────────────────────────

/**
 * AI's approximation of attack odds (1–99).
 *
 * SDK: CvUnitAI::AI_attackOdds (CvUnitAI.cpp line 711-785)
 *
 * Attacker uses currCombatStr(NULL, NULL) — includes getExtraCombatPercent()
 * (Combat I-VI promotions) but no terrain/plot/vs-type modifiers.
 * Defender uses currCombatStr(pPlot, this) — full defensive modifiers
 * including attacker's tactical bonuses applied as negatives.
 */
function aiAttackOdds(attacker, defenderStack, context) {
  const dIdx = selectBestDefender(attacker, defenderStack, context);
  if (dIdx === -1) return 100;
  const defender = defenderStack[dIdx];

  // Attacker: currCombatStr(NULL, NULL) — includes getExtraCombatPercent() only
  // SDK line 733: iOurStrength = currCombatStr(NULL, NULL)
  const aBaseMod = getAttackerBaseModifier(attacker);
  const ourMaxStr = maxCombatStrScaled(attacker.strength, aBaseMod);
  let ourStr = Math.trunc(ourMaxStr * attacker.hp / COMBAT_GLOBALS.maxHP);

  // SDK line 734: iOurFirepower = currFirepower(NULL, NULL)
  const ourFP = Math.trunc((ourMaxStr + ourStr + 1) / 2);

  if (ourStr === 0) return 1;

  // Defender: currCombatStr(pPlot, this) — full combined modifier
  // SDK line 741-742
  const dMod = getCombinedDefenderModifier(attacker, defender, context);
  const theirMaxStr = maxCombatStrScaled(defender.strength, dMod);
  let theirStr = Math.trunc(theirMaxStr * defender.hp / COMBAT_GLOBALS.maxHP);
  const theirFP = Math.trunc((theirMaxStr + theirStr + 1) / 2);

  // SDK line 748
  const baseOdds = Math.trunc(100 * ourStr / (ourStr + theirStr));
  if (baseOdds === 0) return 1;

  // SDK line 754-757: Damage calculations
  const sf = Math.trunc((ourFP + theirFP + 1) / 2);
  const dmgToUs = Math.max(1, Math.trunc(20 * (theirFP + sf) / (ourFP + sf)));
  const dmgToThem = Math.max(1, Math.trunc(20 * (ourFP + sf) / (theirFP + sf)));

  // SDK line 759-762: Rounds needed (using integer ceiling: (a + b - 1) / b)
  const hitLimitThem = COMBAT_GLOBALS.maxHP - (attacker.combatLimit || 100);
  const hpToKillThem = Math.max(0, defender.hp - hitLimitThem);
  let neededRoundsUs = hpToKillThem > 0 ? Math.trunc((hpToKillThem + dmgToThem - 1) / dmgToThem) : 0;
  let neededRoundsThem = Math.trunc((attacker.hp + dmgToUs - 1) / dmgToUs);

  // SDK line 766-767: First strike adjustment
  // Uses: firstStrikes() + chanceFirstStrikes()/2  (integer division)
  const aFSInfo = getEffectiveFirstStrikes(attacker);
  let attackerFS = aFSInfo.guaranteed + Math.trunc(aFSInfo.chances / 2);
  const dFSInfo = getEffectiveFirstStrikes(defender);
  let defenderFS = dFSInfo.guaranteed + Math.trunc(dFSInfo.chances / 2);

  // SDK: immunity check is inside the expression
  if (isUnitImmuneToFirstStrikes(defender)) attackerFS = 0;
  if (isUnitImmuneToFirstStrikes(attacker)) defenderFS = 0;

  // SDK line 766: iNeededRoundsUs -= (iBaseOdds * attackerFS) / 100  (integer division, no rounding)
  neededRoundsUs = Math.max(1, neededRoundsUs - Math.trunc(baseOdds * attackerFS / 100));
  // SDK line 767: iNeededRoundsThem -= ((100 - iBaseOdds) * defenderFS) / 100
  neededRoundsThem = Math.max(1, neededRoundsThem - Math.trunc((100 - baseOdds) * defenderFS / 100));

  // SDK line 770-778: Adjust strength by rounds difference
  const roundsDiff = neededRoundsUs - neededRoundsThem;
  if (roundsDiff > 0) {
    theirStr *= (1 + roundsDiff);
  } else {
    ourStr *= (1 - roundsDiff);
  }

  // SDK line 780-781
  let odds = Math.trunc(ourStr * 100 / (ourStr + theirStr));
  odds += Math.trunc((100 - odds) * getEffectiveWithdrawalChance(attacker) / 100);

  // SDK line 782: iOdds += GET_PLAYER(...).AI_getAttackOddsChange() — player-level AI tweak, omitted

  return Math.max(1, Math.min(odds, 99));
}

// ── AI Sacrifice Value (CvUnitAI::AI_sacrificeValue) ───────────────────

/**
 * Sacrifice value: higher = more expendable = sent first when odds < 68%.
 *
 * SDK: CvUnitAI::AI_sacrificeValue (CvUnitAI.cpp line 1008-1053)
 *
 * Uses currEffectiveStr(pPlot, this) — the attacker's strength with plot-based
 * attack modifiers against an unknown defender (getExtraCombatPercent + city attack
 * + hills attack + feature attack, but NOT vs-unit-type or vs-unit-class).
 *
 * currEffectiveStr = currCombatStr * (maxHP + currHP) / (2 * maxHP)
 * This additional HP penalty means wounded units have lower sacrifice value
 * (they're seen as more valuable since they already took damage = invested).
 */
function aiSacrificeValue(attacker, defenderStack, context) {
  // SDK line 1038: currEffectiveStr(pPlot, this) — attacker vs unknown defender on plot
  // Uses getExtraCombatPercent + plot-based attack modifiers (city/hills/feature)
  // but skips defender-specific modifiers (vs-unit-type, vs-unit-class)
  const attackerMod = getAttackerBaseModifier(attacker)
    + (context.isAttackingCity && attacker.cityAttackBonus ? attacker.cityAttackBonus : 0)
    + (context.isAttackingCity ? getPromoCityAttackMod(attacker) : 0)
    + (context.isHills ? getPromoHillsAttackMod(attacker) : 0)
    + (context.featureType ? getPromoFeatureAttackMod(attacker, context.featureType) : 0);
  const aMaxStr = maxCombatStrScaled(attacker.strength, attackerMod);
  const aCurrStr = Math.trunc(aMaxStr * attacker.hp / COMBAT_GLOBALS.maxHP);

  // SDK: currEffectiveStr = currCombatStr * (maxHP + currHP) / (2 * maxHP)
  const currEffStr = Math.trunc(aCurrStr * (COMBAT_GLOBALS.maxHP + attacker.hp) / (2 * COMBAT_GLOBALS.maxHP));

  // SDK lines 1011-1022: Collateral damage value
  let collateralValue = 0;
  const numDefenders = defenderStack.filter(d => d.hp > 0).length;
  const possibleTargets = Math.min(
    numDefenders - 1,
    attacker.collateralDamageMaxUnits || 0
  );
  if (possibleTargets > 0 && (attacker.collateralDamage || 0) > 0) {
    collateralValue = attacker.collateralDamage;
    collateralValue += Math.max(0, collateralValue - 100);
    collateralValue = Math.trunc(collateralValue * possibleTargets / 5);
  }

  // SDK line 1040: cityDefenseModifier() — unit base + promotions
  let cityDefMod = attacker.cityDefenseBonus || 0;
  if (attacker.promotions) {
    for (const p of attacker.promotions) {
      if (p.cityDefensePercent) cityDefMod += p.cityDefensePercent;
    }
  }

  // SDK lines 1038-1049
  let value = 128 * currEffStr;
  value = Math.trunc(value * (100 + collateralValue) / (100 + cityDefMod));
  value = Math.trunc(value * (100 + getEffectiveWithdrawalChance(attacker)));
  value = Math.trunc(value / Math.max(1, 1 + (attacker.cost || 0)));
  value = Math.trunc(value / (10 + (attacker.experience || 0)));

  // SDK lines 1045-1049: Siege units (combatLimit < 100) are preferred sacrifices
  if ((attacker.combatLimit || 100) < 100) {
    value = Math.trunc(value * 150 / 100);
  }

  return value;
}

// Helper: sum city attack % from promotions
function getPromoCityAttackMod(unit) {
  let mod = 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.cityAttackPercent) mod += p.cityAttackPercent;
    }
  }
  return mod;
}

// Helper: sum hills attack % from promotions
function getPromoHillsAttackMod(unit) {
  let mod = 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.hillsAttackPercent) mod += p.hillsAttackPercent;
    }
  }
  return mod;
}

// Helper: sum feature attack % for a specific feature from promotions
function getPromoFeatureAttackMod(unit, featureType) {
  if (!featureType) return 0;
  let mod = 0;
  if (unit.promotions) {
    for (const p of unit.promotions) {
      if (p.featureAttackPercent && p.featureAttackPercent[featureType]) {
        mod += p.featureAttackPercent[featureType];
      }
    }
  }
  return mod;
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
 *
 * SDK: resolveCombat() (CvUnit.cpp line 1051-1178):
 *   1. collateralCombat() called BEFORE the combat loop (line 1076)
 *   2. Combat rounds follow (line 1078+)
 *
 * Collateral damage uses the attacker's PRE-COMBAT HP (full strength).
 * Even if the attacker dies in combat, collateral already happened.
 */
function runAttackerCombat(attacker, defenders, context) {
  if (attacker.hp <= 0) return;

  const dIdx = selectBestDefender(attacker, defenders, context);
  if (dIdx === -1) return;

  // SDK line 1076: Collateral damage BEFORE combat (uses pre-combat HP)
  applyCollateralDamage(attacker, defenders, dIdx);

  // SDK line 1078+: Combat rounds
  const result = simulateSingleCombat(attacker, defenders[dIdx], context);
  attacker.hp = result.attackerHP;
  defenders[dIdx].hp = result.defenderHP;

  // SDK lines 1086, 1167: Flanking strikes on attacker win or withdrawal
  // SDK line 11623: Only outside cities (isCity returns true for city combat)
  if (!context.isAttackingCity && attacker.flankingStrikes) {
    const attackerWon = result.attackerHP > 0 && result.defenderHP <= 0;
    const attackerWithdrew = result.withdrawn && result.attackerHP > 0;
    if (attackerWon || attackerWithdrew) {
      applyFlankingStrikes(attacker, defenders, dIdx, result.iAttackerKillOdds, result.dmgToDefender);
    }
  }
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
