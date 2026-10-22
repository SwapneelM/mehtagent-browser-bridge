/* Shared validation; policy changes are accepted only from extension UI. */
const SitePolicy = (() => {
  const blockedHosts = ["accounts.google.com", "myaccount.google.com", "payments.google.com", "pay.google.com", "wallet.google.com", "paypal.com", "stripe.com", "checkout.com", "squareup.com", "adyen.com", "braintreepayments.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "capitalone.com", "americanexpress.com", "discover.com", "venmo.com", "cash.app", "wise.com", "revolut.com"];
  function url(value) {
    const u = new URL(value);
    if (u.hostname.includes("*")) throw new Error("Wildcard websites are blocked; choose one exact host");
    if (u.hostname.endsWith(".")) throw new Error("Trailing-dot website names are blocked");
    if (u.username || u.password) throw new Error("URLs with credentials are blocked");
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new Error("Use HTTPS (or localhost for local testing)");
    return u;
  }
  function hardBlock(value) {
    let u; try { u = url(value); } catch (e) { return e.message; }
    const host = u.hostname.toLowerCase();
    if (blockedHosts.some(h => host === h || host.endsWith("." + h)) || /(^|[.-])(bank|banking|payment|payments|checkout)([.-]|$)/i.test(host)) return "Banking, payment and account-security hosts are blocked";
    let path; try { path = decodeURIComponent(u.pathname); } catch { return "Malformed URL path"; }
    if (/(^|\/)(checkout|payments?|billing|wallet|banking|credit[-_]?cards?|signin|login|oauth|authorize)(\/|$)/i.test(path)) return "Payment, billing and sign-in pages are blocked";
    return "";
  }
  function entry(value, mode) {
    const u = url(value);
    if (!["allow", "ask", "block"].includes(mode)) throw new Error("Choose Allow, Ask or Block");
    if (mode !== "block" && hardBlock(u.href)) throw new Error(hardBlock(u.href));
    if (u.pathname !== "/" || u.search || u.hash) throw new Error("Enter a website origin only, for example https://docs.google.com");
    return { origin: u.origin, mode, pattern: u.protocol + "//" + u.hostname + "/*" };
  }
  function mode(value, rules) {
    if (hardBlock(value)) return "block";
    return rules[url(value).origin] || "block";
  }
  return { url, hardBlock, entry, mode, blockedHosts };
})();
if (typeof module !== "undefined") module.exports = SitePolicy;
