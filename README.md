# BinderHunt

Swipe to find the cards your binder is missing.

A swipe-style browser for real Pokémon TCG cards (data from the free Pokémon TCG API). Swipe right to add a card to your wishlist, left to skip. No packs, no gambling.

Live: https://kyrohmotz.github.io/binderhunt/

## Sharing a binder

From Binders, Share opens a pastel card for one binder or the wishlist. Save image downloads a PNG. Copy link copies a link on this site (`/binderhunt/?share=binder&name=…&pocket=…`) with the binder name and up to six cards already stored in the browser: id, name, set, number, and a card image from the usual art hosts. Opening that link shows a read-only showcase. It does not write the other person's wishlist or binders, and it does not call Scrydex. Open X only fills a composer with the caption and the link. BinderHunt does not post.

## Daily Drop

`data/daily.json` is the shared card for each America/New_York day. The file stores the card id and the printing the profile selects (the cheapest TCGplayer market). Around 4:00 AM New York time, a GitHub Action asks TCGdex for that printing's price for the next two days and stores the snapshot. It does not call Scrydex, and it does not change a day that has already started. The site uses the snapshot, so everyone sees the same answer. If a snapshot is missing, the site loads the card from TCGdex and locks the price on the first guess. The stored card price is only a fallback when both of those are missing. Cards with no TCGplayer market price are left out. Cardmarket uses the average, converted with `data/fx.json` at play time.

The schedule is about 400 days. A Monday GitHub Action appends new days when fewer than 60 are left, then publishes the site. It does not reuse a card or an old price. To extend it by hand:

```bash
python3 scripts/build_daily.py --extend
```

A fresh year, which replaces unpublished days, is `python3 scripts/build_daily.py`.
