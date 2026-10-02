# Checkout integration requirements

Status: requirements and research only. **No provider is selected.** No account was created, no checkout link exists, no payment code is in the repository, and the app does not know about payments. All provider facts below were read from the providers' **official** pages on **2026-10-02** and can change; re-check before deciding. The owner is based in Bangladesh (BDT payout wanted). Offer being sold: see [commercial-plan.md](commercial-plan.md).

## 1. Requirements

| #   | Requirement                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | One-time purchase (no subscription): US$15 standard, optional US$29 supporter, a future paid major upgrade as a separate product                                                                                      |
| R2  | **No license keys.** Delivery is a **download link plus the provider's receipt/invoice** (and an email). Nothing in the app checks a purchase. The download page also shows the SHA-256 and the GPL source offer      |
| R3  | Prefer a **merchant of record** (MoR) so sales tax/VAT/GST collection and remittance for buyers' countries is handled by the provider, not the owner                                                                  |
| R4  | Refunds: the owner's proposed 14-day policy ([commercial-plan.md](commercial-plan.md)) must be supported by the provider's refund tooling and terms                                                                   |
| R5  | **Payout to a Bangladesh-based seller**, ideally in BDT to a local bank account (or via a payout method that reaches Bangladesh reliably, such as Payoneer if the provider supports it)                               |
| R6  | Provider's terms must allow selling GPL/open-source software and a download-only product, with no content restrictions that conflict with the product                                                                 |
| R7  | Published, understandable fees; minimum payout thresholds and payout schedule known in advance                                                                                                                        |
| R8  | Buyer-facing: receipts, EU/UK VAT invoices handled by the provider, a way for buyers to re-download after the update term and contact support (support email in the receipt)                                          |
| R9  | Privacy: collect only what the provider needs (email for the receipt). Supporter name for the list is optional, collected at checkout or by reply. No tracking added by Framelet's own pages; no analytics in the app |
| R10 | Webhooks or API are **not required**; a hosted checkout page and hosted download are enough. Any future automation (for example emailing a supporter list) must be GPL-compatible and not gate the software           |
| R11 | Support mailbox and legal pages (terms of sale, refund policy, privacy) published before the first sale; reviewed by the owner or a lawyer                                                                            |
| R12 | Reproducible, hash-listed installer file hosted where the provider's delivery mechanism or the owner's static host can serve it                                                                                       |

## 2. Provider research (official pages only)

"Seller country" answers the question: can an individual or business based in Bangladesh sign up and get paid? Statuses: **yes** (the official page explicitly lists Bangladesh), **not excluded** (page names only excluded countries and Bangladesh is not among them, but an explicit approval or bank-wire acceptance for Bangladesh is not stated), **no**, **unclear**. Fees are the numbers shown on the provider's own pricing page; whether other fees (currency conversion, payout, PayPal, chargeback) apply is noted where seen and otherwise **unverified**.

### Stripe

- Seller country: **no.** https://stripe.com/global (checked 2026-10-02) lists the countries where Stripe is supported; **Bangladesh is not on it** (India appears as "Preview"). A Bangladesh-based owner cannot open a standard Stripe account.
- MoR: Stripe itself is a payment processor, not a MoR. (A separate "Stripe Managed Payments" MoR offering is mentioned on other providers' pages; its availability for Bangladesh sellers was not verified.)
- Payout methods / fees: not applicable.
- **Verdict: not eligible per official page. Unselected.**

### Paddle

- Seller country: **not excluded, unverified for Bangladesh.** https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle (2026-10-02): "Paddle works with software businesses anywhere in the world with the exception of the unsupported countries listed below"; the list (29 countries/regions, for example Afghanistan, Cuba, Iran, North Korea, Russia, Syria, Venezuela, Yemen) does **not** include Bangladesh. The page does not confirm that a Bangladesh bank or payout rail is accepted. Approval is discretionary ("account verification is required before selling", https://www.paddle.com/pricing).
- Payout methods: bank/wire transfer with a selectable transfer currency; payout currencies listed on https://www.paddle.com/help/manage/get-paid/can-i-be-paid-in-my-local-currency are AUD, GBP, CAD, CNY, CZK, DKK, EUR and others (USD, CHF, SEK, PLN, HUF, ZAR); BDT is not listed (the page says Paddle converts at a competitive rate; "a conversion margin of up to 1.5%" may apply when you choose a currency different from the balance currency). PayPal and Payoneer payouts are **not** mentioned on the pages read: **unverified**.
- MoR: **yes** (https://www.paddle.com/pricing).
- Fees: "5% + 50¢ per Checkout transaction" (https://www.paddle.com/pricing); the page says "if you're selling product with under 10$ value you can contact us for bespoke pricing". On a US$15 sale that is US$1.25 (8.3%). Payout fee: not stated on the page read.
- Note: https://developer.paddle.com/concepts/sell/supported-countries-locales lists Bangladesh (BD, USD) only as a **buyer** country, not a seller country.
- **Verdict: plausible, but Bangladesh payout acceptance unverified. Unselected.** Would need a pre-application question to Paddle.

### Lemon Squeezy

- Seller country: **yes (bank payouts).** https://docs.lemonsqueezy.com/help/getting-started/supported-countries (2026-10-02) lists **Bangladesh** under "Bank payouts supported in the following countries" and states Lemon Squeezy serves merchants who "can receive bank or PayPal payouts in one of the hundreds of countries" supported. PayPal payouts are described as available in 200+ countries (not individually confirmed for Bangladesh).
- Payout methods: bank wire or PayPal, processed twice monthly (https://www.lemonsqueezy.com/pricing); I did not confirm the payout currency for Bangladesh banks or whether payout can be BDT (**unverified**); no Payoneer.
- MoR: **yes** (https://www.lemonsqueezy.com/pricing: "handle[s] tax collection and calculation liability across all jurisdictions").
- Fees: "5% + 50¢" per transaction, no monthly fee; "international transactions may incur small additional fees" and some payments incur "edge-case fees" (https://www.lemonsqueezy.com/pricing). On US$15: US$1.25 (8.3%) before extra fees; on US$29: US$1.95 (6.7%).
- The pricing page also mentions an integration with "Stripe Managed Payments" (2026 announcement); the relationship between that and Lemon Squeezy's own seller eligibility for Bangladesh was **not verified**.
- Account approval (store review) is typical for MoRs; its criteria were not read.
- **Verdict: the best-supported option on official pages for a Bangladesh seller (bank payout listed, MoR, fees published). Still unselected** until the owner reads the current terms (prohibited products, review process, payout currency/fees) and confirms that the owner's identity/bank details are accepted.

### Gumroad

- Seller country: **yes (bank payouts in BDT).** https://gumroad.com/help/article/13-getting-paid (2026-10-02): the table of countries with direct bank deposits lists **Bangladesh, payout currency BDT**. Requirements for bank payouts: a government-issued photo ID, proof of residence in that country (or a business registered there); the bank account must be in that country; standard minimum payout US$100 (equivalent); bank payouts take 2-7 business days. Payout currency conversion uses rates at the time of sale.
- Payout methods: bank deposit in local currency, or PayPal (USD, 2% processing fee). **"We do not support alternative payout modes like Payoneer, Wise, check, money order, wire transfer."**
- MoR: **yes** per https://gumroad.com/pricing: "Since January 1, 2025, Gumroad handles ALL your tax obligations."
- Fees: "10% + $0.50" per direct sale and "30%" for sales through Gumroad Discover (https://gumroad.com/pricing); no monthly fee. On US$15: US$2.00 (13.3%); on US$29: US$3.40 (11.7%). Other fees (for example processor or payout fees) were not fully verified.
- **Verdict: eligible on official pages (BDT bank payout listed), higher fees. Still unselected.** The owner should read the current terms and confirm they accept software distributed under the GPL with a download link.

### FastSpring

- Seller country: **not excluded, unverified for Bangladesh.** https://developer.fastspring.com/docs/fastspring-payouts-portal (2026-10-02) lists regions where the Payouts Portal cannot pay sellers (Cuba, Iran, Iraq, Myanmar, North Korea, Russia, Somalia, Sudan, Syria); Bangladesh is not on it. No page read states that Bangladesh bank payouts are supported.
- Payout methods: bank transfer via the Payouts Portal (and PayPal during account set-up); payout currencies USD, EUR, GBP, AUD, CAD; default minimum US$100; "FastSpring applies a 2.5% currency conversion fee" when store and payout currencies differ (https://developer.fastspring.com/docs/receive-payouts). BDT payout: not listed.
- MoR: **yes** (https://fastspring.com/pricing/).
- Fees: **not published** (custom quote via sales; "no hidden fees"). Fit for small US$15 sales is unknown.
- **Verdict: unverified. Unselected.**

### Payoneer (payout method, not a checkout provider)

- Bangladesh: https://www.payoneer.com/resources/business/pay-your-contractors-and-remote-employees-in-bangladesh/ (2026-10-02) states Bangladeshi recipients can withdraw to a local bank account or bKash, or use an ATM card, and Payoneer receiving accounts take USD, EUR, GBP and other currencies. (Exact fees, KYC and whether it accepts payouts from a given MoR: **unverified**.)
- Provider support: Gumroad states it does **not** pay out via Payoneer. Paddle's and Lemon Squeezy's official pages read did not list Payoneer as a payout method (**unverified**). Do not assume a provider can pay into a Payoneer account; ask the provider before relying on it.

## 3. Summary

| Provider      | Seller in Bangladesh (official page)                | MoR | Published fee                      | BDT payout                                 | Selected |
| ------------- | --------------------------------------------------- | --- | ---------------------------------- | ------------------------------------------ | -------- |
| Stripe        | **No** (Bangladesh not on stripe.com/global)        | No  | n/a                                | n/a                                        | No       |
| Paddle        | Not excluded; Bangladesh payout unverified          | Yes | 5% + $0.50                         | No (USD, EUR, GBP, others; BDT not listed) | **No**   |
| Lemon Squeezy | **Yes** (listed under bank payouts)                 | Yes | 5% + $0.50 (+ possible extra fees) | Unverified (bank payout currency not read) | **No**   |
| Gumroad       | **Yes** (listed, BDT)                               | Yes | 10% + $0.50                        | **Yes** (bank deposit in BDT, min US$100)  | **No**   |
| FastSpring    | Not excluded; unverified                            | Yes | Not published                      | No (USD, EUR, GBP, AUD, CAD)               | **No**   |
| Payoneer      | Supports Bangladesh recipients (payout method only) | n/a | n/a                                | Local bank / bKash withdrawal per Payoneer | n/a      |

**No provider is recommended or selected by this document.** Lemon Squeezy and Gumroad are the two with explicit official evidence for Bangladesh sellers; the owner decides after reading current terms, reviewing the fee impact on a US$15 price, and confirming with the provider (support or sales) that their identity and bank can be accepted. If none works, a fallback is selling through an entity registered in a supported country, which needs legal and tax advice.

## 4. What the repository must not do

- No payment SDKs, no purchase checks, no license keys or activation, no feature gating, no network calls from the app.
- Purchase pages, if any, are separate from the app (static page or the provider's hosted page) and are an owner task. No live links or accounts have been created.

## 5. Owner decisions needed

Provider choice and application; whether to sell as an individual or a registered business (affects provider approval, tax and refunds); price confirmation after fees; refund policy; legal pages; delivery host; support address; supporter list handling.
