// Share-link encoding for a binder or wishlist. No network, no DOM.
// Run: npx -y node@22 scripts/test_share.mjs
import assert from "node:assert/strict";
import share from "../js/share.js";

const {
  buildPayload, shareUrl, readQuery, countLine, shareCaption, intentUrl,
  fileSlug, packArt, unpackArt, artCandidates, CANONICAL, MAX_POCKETS
} = share;

function check(name, fn) {
  try {
    fn();
    console.log("ok", name);
  } catch (error) {
    console.error("FAIL", name);
    throw error;
  }
}

const charizard = {
  id: "base1-4",
  name: "Charizard",
  set: "Base",
  number: "4",
  price: 400,
  thumb: "https://assets.tcgdex.net/en/base/base1/4/low.webp",
  img: "https://assets.tcgdex.net/en/base/base1/4/high.webp"
};

check("a binder round-trips name, color, counts, and cards", () => {
  const payload = buildPayload({
    kind: "binder",
    name: " Jungle ",
    color: "#abb28d",
    cards: [charizard, { id: "base1-15", name: "Venusaur", set: "Base", number: "15", img: "https://images.pokemontcg.io/base1/15.png" }],
    ownedIds: ["base1-4"]
  });
  const url = shareUrl(payload, "https://kyrohmotz.github.io/binderhunt/index.html?card=ignore");
  assert.equal(url.startsWith("https://kyrohmotz.github.io/binderhunt/?"), true);
  assert.equal(url.includes("index.html"), false);
  assert.equal(url.includes("card=ignore"), false);
  assert.match(url, /(?:^|[?&])share=binder(?:&|$)/);
  assert.match(url, /(?:^|[?&])name=Jungle(?:&|$)/);
  assert.match(url, /color=ABB28D/);
  assert.match(url, /pocket=base1-4/);
  assert.equal(url.includes("400"), false);
  const back = readQuery(url);
  assert.deepEqual(back, payload);
  assert.equal(back.cards[0].owned, true);
  assert.equal(back.cards[0].art, "https://assets.tcgdex.net/en/base/base1/4/low.webp");
  assert.equal(back.cards[1].art, "https://images.pokemontcg.io/base1/15.png");
  assert.equal(back.got, 1);
  assert.equal(back.count, 2);
});

check("the link stays under /binderhunt/ on any host", () => {
  const payload = buildPayload({ kind: "binder", name: "Water", cards: [charizard] });
  const url = shareUrl(payload, "http://127.0.0.1:8796/binderhunt/");
  assert.equal(url.startsWith("http://127.0.0.1:8796/binderhunt/?share=binder"), true);
  assert.equal(readQuery(url).name, "Water");
  const bare = shareUrl(payload);
  assert.equal(bare.startsWith(CANONICAL + "?"), true);
});

check("a wishlist link is readable and keeps an apostrophe", () => {
  const payload = buildPayload({
    kind: "wish",
    name: "Wishlist",
    color: "not-a-color",
    cards: [{ id: "base1-27", name: "Farfetch'd", set: "Base", number: "27" }]
  });
  assert.equal(payload.color, "E4E7DA");
  const url = shareUrl(payload, CANONICAL);
  assert.match(url, /share=wish/);
  assert.match(url, /name=Wishlist/);
  const back = readQuery(url);
  assert.equal(back.cards[0].name, "Farfetch'd");
  assert.equal(back.kind, "wish");
});

check("only the first six pockets are encoded, and the full count stays", () => {
  const cards = [];
  for (let i = 0; i < 8; i++) {
    cards.push({ id: "base1-" + (i + 1), name: "Card " + (i + 1), set: "Base", number: String(i + 1) });
  }
  const payload = buildPayload({
    kind: "binder",
    name: "Full",
    cards,
    ownedIds: new Set(["base1-8"])
  });
  assert.equal(payload.cards.length, MAX_POCKETS);
  assert.equal(payload.count, 8);
  assert.equal(payload.got, 1);
  assert.equal(payload.cards.some(card => card.id === "base1-8"), false);
  const back = readQuery(shareUrl(payload, CANONICAL));
  assert.equal(back.count, 8);
  assert.equal(back.got, 1);
  assert.equal(back.cards.length, 6);
  assert.equal(countLine(back), "8 cards · 1 owned · showing 6");
});

check("prices and other hosts never enter the link", () => {
  assert.equal(packArt("javascript:alert(1)"), "");
  assert.equal(packArt("https://evil.example/card.png"), "");
  assert.equal(packArt("https://assets.tcgdex.net/en/../secret.webp"), "");
  assert.equal(unpackArt("d:en/../../etc/passwd"), "");
  assert.equal(unpackArt("x:en/base/base1/4/low.webp"), "");
  const payload = buildPayload({
    kind: "binder",
    name: "Nope",
    cards: [{
      id: "base1-4",
      name: "Charizard",
      price: 0,
      img: "https://evil.example/card.png",
      thumb: "data:image/png;base64,aaaa"
    }]
  });
  assert.equal(payload.cards[0].art, "");
  const url = shareUrl(payload, CANONICAL);
  assert.equal(url.includes("evil.example"), false);
  assert.equal(url.includes("data:"), false);
  assert.equal(url.includes("$"), false);
  assert.equal(url.toLowerCase().includes("nan"), false);
});

check("tildes and blank names are cleaned, and a dotted id survives", () => {
  const payload = buildPayload({
    kind: "binder",
    name: "Sky~\nLine",
    cards: [{ id: "sv03.5-12", name: "Mr. Mime", set: "Paldean Fates", number: "12" }]
  });
  assert.equal(payload.name, "Sky Line");
  const back = readQuery(shareUrl(payload, CANONICAL));
  assert.equal(back.name, "Sky Line");
  assert.equal(back.cards[0].id, "sv03.5-12");
  assert.equal(back.cards[0].name, "Mr. Mime");
});

check("garbage and a bare card deep link do not open a showcase", () => {
  assert.equal(readQuery(""), null);
  assert.equal(readQuery("?card=base1-4"), null);
  assert.equal(readQuery("?share=binder"), null);
  assert.equal(readQuery("?share=nope&name=Hi"), null);
  assert.equal(readQuery("%%%"), null);
  assert.equal(readQuery("?share=binder&name=%20"), null);
  const mixed = readQuery("?card=base1-4&share=wish&n=3&got=9&pocket=nope&pocket=base1-2~Ivysaur~Base~2~0~");
  assert.equal(mixed.kind, "wish");
  assert.equal(mixed.name, "Wishlist");
  assert.equal(mixed.cards.length, 1);
  assert.equal(mixed.count, 3);
  assert.equal(mixed.got, 3);
});

check("owned flags and an empty binder stay honest", () => {
  const empty = buildPayload({ kind: "binder", name: "Fresh", cards: [] });
  assert.equal(countLine(empty), "No cards yet");
  assert.equal(shareCaption(empty), "My Fresh binder on BinderHunt.");
  assert.equal(shareCaption(empty).includes("NaN"), false);
  assert.equal(shareCaption(empty).includes("$"), false);
  const one = buildPayload({
    kind: "binder",
    name: "Solo",
    cards: [charizard],
    ownedIds: ["base1-4"]
  });
  assert.equal(countLine(one), "1 card · 1 owned");
  assert.equal(shareCaption(one), "My Solo binder on BinderHunt — 1 card.");
  const wish = buildPayload({ kind: "wish", name: "Wishlist", cards: [charizard, { id: "base1-1", name: "Alakazam" }] });
  assert.equal(shareCaption(wish), "My BinderHunt wishlist — 2 cards.");
  assert.equal(shareCaption(wish).includes("@"), false);
});

check("Open X is a composer link, not a post", () => {
  const payload = buildPayload({ kind: "binder", name: "Jungle", cards: [charizard] });
  const page = shareUrl(payload, CANONICAL);
  const intent = intentUrl(payload, page);
  assert.equal(intent.startsWith("https://x.com/intent/post?"), true);
  assert.equal(intent.includes("statuses"), false);
  assert.equal(intent.includes("api.x.com"), false);
  assert.equal(intent.includes("api.twitter.com"), false);
  const text = new URL(intent).searchParams.get("text");
  assert.match(text, /Jungle/);
  assert.match(text, /binderhunt\/\?share=binder/);
  assert.equal(text.includes("@"), false);
  assert.equal(text.includes("$"), false);
  assert.equal(text.includes("NaN"), false);
});

check("a low scan falls back to the high file for the picture export", () => {
  assert.deepEqual(artCandidates("https://assets.tcgdex.net/en/base/base1/4/low.webp"), [
    "https://assets.tcgdex.net/en/base/base1/4/high.webp",
    "https://assets.tcgdex.net/en/base/base1/4/low.webp"
  ]);
  assert.deepEqual(artCandidates("https://images.pokemontcg.io/base1/4.png"), [
    "https://images.pokemontcg.io/base1/4.png"
  ]);
  assert.deepEqual(artCandidates("https://evil.example/low.webp"), []);
  assert.deepEqual(artCandidates(""), []);
});

check("file names stay plain", () => {
  assert.equal(fileSlug("Jungle Binder"), "jungle-binder");
  assert.equal(fileSlug("Pokémon"), "pokemon");
  assert.equal(fileSlug("!!!"), "binder");
});

check("a count smaller than the pockets does not hide a card", () => {
  const back = readQuery("?share=binder&name=Two&n=1&pocket=base1-1~A~Base~1~0~&pocket=base1-2~B~Base~2~1~");
  assert.equal(back.count, 2);
  assert.equal(back.got, 1);
  assert.equal(back.cards.length, 2);
});

console.log("share checks passed");
