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
TIER_A = 200
TIER_B = CHASE_CARDS - TIER_A
TIER_A_PER_MONTH = 15  # every 48 hours across a 30-day month
MONTH_DAYS = 30
TIER_B_INTERVAL_DAYS = 7
CURRENT_MAX_PER_RUN = 10

PLANS = (
    {"name": "Starter", "monthly_usd": 29, "included": 5_000, "overage_usd": 0.006},
    {"name": "Growth", "monthly_usd": 99, "included": 50_000, "overage_usd": 0.002},
    {"name": "Professional", "monthly_usd": 399, "included": 250_000, "overage_usd": 0.0016},
)


def backfill_credits(miss_then_hit: bool = False) -> int:
    each = MISS_THEN_HIT_CREDITS if miss_then_hit else HIT_CREDITS
    return CHASE_CARDS * each


def monthly_credits_exact() -> float:
    """Tier A every 48 hours, tier B once a week, 4 credits per refresh."""
    tier_a = TIER_A * HIT_CREDITS * TIER_A_PER_MONTH
    tier_b = TIER_B * HIT_CREDITS * (MONTH_DAYS / TIER_B_INTERVAL_DAYS)
    return tier_a + tier_b


def monthly_credits() -> int:
    return round(monthly_credits_exact())


def aggressive_monthly_credits() -> int:
    """Every chase card refreshed every 48 hours."""
    return CHASE_CARDS * HIT_CREDITS * TIER_A_PER_MONTH


def plan_cost(credits: float, plan: dict) -> float:
    extra = max(0.0, credits - plan["included"])
    return plan["monthly_usd"] + extra * plan["overage_usd"]


def cards_per_day_to_stay_fresh() -> float:
    return (TIER_A / 2) + (TIER_B / TIER_B_INTERVAL_DAYS)


def rank_demand(counts: dict[str, int], limit: int = CHASE_CARDS) -> list[str]:
    """Highest local or proxy demand first. Ties break on the catalog id."""
    ranked = sorted(counts.items(), key=lambda item: (-int(item[1]), item[0]))
    return [card_id for card_id, _count in ranked[:limit]]


def estimate() -> dict:
    monthly = monthly_credits_exact()
    aggressive = aggressive_monthly_credits()
    plans = []
    for plan in PLANS:
        plans.append(
            {
                "name": plan["name"],
                "monthly_usd": plan["monthly_usd"],
                "included": plan["included"],
                "overage_usd": plan["overage_usd"],
                "tiered_usd": round(plan_cost(monthly, plan), 2),
                "aggressive_usd": round(plan_cost(aggressive, plan), 2),
            }
        )
    return {
        "chase_cards": CHASE_CARDS,
        "credits_per_hit": HIT_CREDITS,
        "backfill_credits": backfill_credits(False),
        "backfill_credits_if_mapped_404_then_hit": backfill_credits(True),
        "monthly_credits_tiered": monthly_credits(),
        "monthly_credits_tiered_exact": monthly,
        "monthly_credits_if_all_refresh_every_48h": aggressive,
        "tier_a_cards": TIER_A,
        "tier_b_cards": TIER_B,
        "cards_per_day_to_stay_fresh": cards_per_day_to_stay_fresh(),
        "current_max_per_run": CURRENT_MAX_PER_RUN,
        "runs_to_backfill_at_current_cap": CHASE_CARDS // CURRENT_MAX_PER_RUN,
        "plans": plans,
        "recommended_plan": "Growth",
        "pricing_page": "https://scrydex.com/pricing",
        "spent_credits": 0,
    }


def main() -> int:
    report = estimate()
    growth = next(plan for plan in report["plans"] if plan["name"] == "Growth")
    starter = next(plan for plan in report["plans"] if plan["name"] == "Starter")
    print("Scrydex coverage estimate (no API calls made, spent_credits=0)")
    print(
        f"Backfill {report['chase_cards']} chase cards at {report['credits_per_hit']} credits each: "
        f"{report['backfill_credits']} credits if every mapped id hits, "
        f"or {report['backfill_credits_if_mapped_404_then_hit']} if each 404s once and then hits."
    )
    print(
        f"Steady state, {report['tier_a_cards']} cards every 48 hours and "
        f"{report['tier_b_cards']} weekly: {report['monthly_credits_tiered']} credits/month."
    )
    print(
        f"That is ${growth['tiered_usd']:.0f}/month on Growth "
        f"({growth['included']} included) and about ${starter['tiered_usd']:.0f}/month on Starter with overage."
    )
    print(
        f"Refreshing all {report['chase_cards']} every 48 hours is "
        f"{report['monthly_credits_if_all_refresh_every_48h']} credits/month, "
        f"about ${growth['aggressive_usd']:.0f} on Growth."
    )
    print(
        f"The daily job still caps at {report['current_max_per_run']} cards. "
        f"Filling {report['chase_cards']} at that cap takes {report['runs_to_backfill_at_current_cap']} runs "
        f"and cannot keep {report['cards_per_day_to_stay_fresh']:.0f} cards/day fresh."
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
