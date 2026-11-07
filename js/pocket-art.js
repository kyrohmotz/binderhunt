/* Pocket art paths.
   A saved card already carries a thumb, an img, or a TCGdex image base.
   The sharper file is the same path the rest of the app uses (high.webp,
   high.png, or a pokemontcg.io _hires.png). Nothing here calls a catalog.
   107x150 is the old two-circle placeholder, not a card scan. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PocketArt = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PLACEHOLDER_W = 107;
  const PLACEHOLDER_H = 150;

  function safeImg(url) {
    if (typeof url !== "string") return "";
    if (url.startsWith("https://assets.tcgdex.net/") || url.startsWith("https://images.pokemontcg.io/")) return url;
    return "";
  }

  function isFileArt(url) {
    return /\/(high|low)\.(webp|png|jpg)$/.test(url) || /images\.pokemontcg\.io\/.+\.png$/.test(url);
  }

  function pushUnique(list, value) {
    const url = safeImg(value);
    if (url && list.indexOf(url) < 0) list.push(url);
    return url;
  }

  /* Fuller files beside a URL we already have. The original stays out. */
  function sharperFrom(url) {
    const full = safeImg(url);
    if (!full) return [];
    const out = [];
    const push = value => {
      const next = safeImg(value);
      if (next && next !== full && out.indexOf(next) < 0) out.push(next);
    };
    if (/\/low\.webp$/.test(full)) {
      push(full.replace(/\/low\.webp$/, "/high.webp"));
      push(full.replace(/\/low\.webp$/, "/high.png"));
    } else if (/\/low\.png$/.test(full)) {
      push(full.replace(/\/low\.png$/, "/high.webp"));
      push(full.replace(/\/low\.png$/, "/high.png"));
    } else if (/\/high\.webp$/.test(full)) {
      push(full.replace(/\/high\.webp$/, "/high.png"));
    } else if (/^https:\/\/images\.pokemontcg\.io\/[^/]+\/[^/_]+\.png$/.test(full)) {
      push(full.replace(/\.png$/, "_hires.png"));
    }
    return out;
  }

  function isPlaceholderSize(width, height) {
    return width === PLACEHOLDER_W && height === PLACEHOLDER_H;
  }

  /* Thumb and low files first, so a pocket can paint before the scan arrives. */
  function previewUrls(card) {
    const urls = [];
    if (!card) return urls;
    pushUnique(urls, card.thumb);
    pushUnique(urls, card.img);
    const base = safeImg(card.image);
    if (base) pushUnique(urls, isFileArt(base) ? base : base + "/low.webp");
    pushUnique(urls, card.backup);
    return urls;
  }

  function isSharpFile(url) {
    return /\/high\.(webp|png|jpg)$/.test(url) || /_hires\.png$/.test(url);
  }

  /* Full-size files first. An img that is already a scan stays that scan:
     a different thumb must not invent a second card. high.png is the last try. */
  function sharpUrls(card) {
    const urls = [];
    const pngs = [];
    if (!card) return urls;
    const explicit = safeImg(card.img);
    if (explicit && isSharpFile(explicit)) {
      pushUnique(urls, explicit);
      sharperFrom(explicit).forEach(next => {
        if (/\/high\.png$/.test(next)) pushUnique(pngs, next);
      });
      pngs.forEach(url => pushUnique(urls, url));
      return urls;
    }
    const take = value => {
      const url = safeImg(value);
      if (url && isSharpFile(url)) pushUnique(urls, url);
      sharperFrom(value).forEach(next => {
        if (/\/high\.webp$/.test(next) || /_hires\.png$/.test(next)) pushUnique(urls, next);
        else if (/\/high\.png$/.test(next)) pushUnique(pngs, next);
      });
    };
    take(card.img);
    take(card.thumb);
    take(card.image);
    take(card.backup);
    const base = safeImg(card.image);
    if (base && !isFileArt(base)) {
      pushUnique(urls, base + "/high.webp");
      pushUnique(pngs, base + "/high.png");
    }
    pngs.forEach(url => pushUnique(urls, url));
    return urls;
  }

  function pocketSources(card, large) {
    const preview = previewUrls(card);
    if (!large) return preview;
    const out = [];
    sharpUrls(card).forEach(url => pushUnique(out, url));
    preview.forEach(url => pushUnique(out, url));
    return out;
  }

  return {
    PLACEHOLDER_W,
    PLACEHOLDER_H,
    safeImg,
    sharperFrom,
    isPlaceholderSize,
    previewUrls,
    sharpUrls,
    pocketSources
  };
});
