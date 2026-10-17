#!/usr/bin/env python3
"""Estimate Scrydex credits for chase-card coverage.

This module only does arithmetic. It does not open a connection, read secrets,
or contact Scrydex. The published plan prices are the public
figures on https://scrydex.com/pricing (Starter, Growth, Professional).

A usable profile row is one card lookup (1 credit, raw + graded + population)
plus price history (3 credits). That is 4 credits when the mapped id hits.
A mapped id that 404s, then hits on the catalog id, costs 5 because history
is requested only after a hit.
"""

from __future__ import annotations

import json

CARD_CREDITS = 1
HISTORY_CREDITS = 3
HIT_CREDITS = CARD_CREDITS + HISTORY_CREDITS
MISS_THEN_HIT_CREDITS = CARD_CREDITS + HIT_CREDITS
CHASE_CARDS = 2000
TIER_A = 300
TIER_B = CHASE_CARDS - TIER_A
MONTH_DAYS = 30
TIER_A_INTERVAL_DAYS = 7
TIER_B_INTERVAL_DAYS = 30
RUN_CARD_CAP = 100
RUN_CREDIT_CAP = 500
MONTHLY_CAP = 15000
STORE_RESERVE = 15000
USAGE_CHECK_CREDITS = 1

PLANS = (
    {"name": "Starter", "monthly_usd": 29, "included": 5_000, "overage_usd": 0.006},
    {"name": "Growth", "monthly_usd": 99, "included": 50_000, "overage_usd": 0.002},
    {"name": "Professional", "monthly_usd": 399, "included": 250_000, "overage_usd": 0.0016},
)


def backfill_credits(miss_then_hit: bool = False) -> int:
    each = MISS_THEN_HIT_CREDITS if miss_then_hit else HIT_CREDITS
    return CHASE_CARDS * each


def monthly_credits_exact() -> float:
    """Top 300 weekly and the other 1,700 monthly, 4 credits per refresh."""
    tier_a = TIER_A * HIT_CREDITS * (MONTH_DAYS / TIER_A_INTERVAL_DAYS)
    tier_b = TIER_B * HIT_CREDITS * (MONTH_DAYS / TIER_B_INTERVAL_DAYS)
    return tier_a + tier_b


def monthly_credits() -> int:
    return round(monthly_credits_exact())


def days_to_full_coverage(card_cap: int = RUN_CARD_CAP) -> int:
    if card_cap < 1:
        return 0
    return (CHASE_CARDS + card_cap - 1) // card_cap


def plan_cost(credits: float, plan: dict) -> float:
    extra = max(0.0, credits - plan["included"])
    return plan["monthly_usd"] + extra * plan["overage_usd"]


def cards_per_day_to_stay_fresh() -> float:
    return (TIER_A / TIER_A_INTERVAL_DAYS) + (TIER_B / TIER_B_INTERVAL_DAYS)


def rank_demand(counts: dict[str, int], limit: int = CHASE_CARDS) -> list[str]:
    """Highest local or proxy demand first. Ties break on the catalog id."""
    ranked = sorted(counts.items(), key=lambda item: (-int(item[1]), item[0]))
    return [card_id for card_id, _count in ranked[:limit]]


def estimate() -> dict:
    monthly = monthly_credits_exact()
    checks = USAGE_CHECK_CREDITS * MONTH_DAYS
    plans = []
    for plan in PLANS:
        plans.append(
            {
                "name": plan["name"],
                "monthly_usd": plan["monthly_usd"],
                "included": plan["included"],
                "overage_usd": plan["overage_usd"],
                "steady_usd": round(plan_cost(monthly + checks, plan), 2),
            }
        )
    return {
        "chase_cards": CHASE_CARDS,
        "credits_per_hit": HIT_CREDITS,
        "backfill_credits": backfill_credits(False),
        "backfill_credits_if_mapped_404_then_hit": backfill_credits(True),
        "backfill_days": days_to_full_coverage(),
        "monthly_credits_steady": monthly_credits(),
        "monthly_credits_steady_exact": monthly,
        "monthly_credits_with_usage_checks": monthly_credits() + checks,
        "monthly_cap": MONTHLY_CAP,
        "store_reserve": STORE_RESERVE,
        "run_card_cap": RUN_CARD_CAP,
        "run_credit_cap": RUN_CREDIT_CAP,
        "tier_a_cards": TIER_A,
        "tier_a_interval_days": TIER_A_INTERVAL_DAYS,
        "tier_b_cards": TIER_B,
        "tier_b_interval_days": TIER_B_INTERVAL_DAYS,
        "cards_per_day_to_stay_fresh": cards_per_day_to_stay_fresh(),
        "plans": plans,
        "recommended_plan": "Growth",
        "pricing_page": "https://scrydex.com/pricing",
        "spent_credits": 0,
    }


def main() -> int:
    report = estimate()
    print("Scrydex coverage estimate (no API calls made, spent_credits=0)")
    print(
        f"Backfill {report['chase_cards']} cards at {report['run_card_cap']} a day: "
        f"{report['backfill_days']} days, {report['backfill_credits']} credits if every mapped id hits, "
        f"or {report['backfill_credits_if_mapped_404_then_hit']} if each misses once and then hits."
    )
    print(
        f"Steady state, {report['tier_a_cards']} cards weekly and "
        f"{report['tier_b_cards']} monthly: {report['monthly_credits_steady']} credits "
        f"plus {USAGE_CHECK_CREDITS} per day to read the account balance."
    )
    print(
        f"BinderHunt cap {report['monthly_cap']}. "
        f"The run is skipped when the account would drop under {report['store_reserve']} for the store. "
        f"Per-run credit cap {report['run_credit_cap']}."
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
