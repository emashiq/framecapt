# Commercial plan (proposal for the owner)

Status: **proposal only**. Nothing here is on sale. No store, checkout link, payment account, price list page or license server exists; this repository contains no payment code. Every price, term and number below is a suggestion for the owner to confirm. Legal review of the terms is an owner task ([OWNER-TASKS.md](OWNER-TASKS.md)).

## 1. Principles

- Framelet is **fully open source (GPL-3.0-only)**. The complete source, the free-software license and the right to build and run it are available to everyone, always, at no cost.
- What a customer pays for is **the official build and service around the software**: a ready-made, **signed** Windows installer (once the owner has a code-signing certificate; today's builds are unsigned), the convenience of not building it themselves, a defined period of updates, and defined support. It is not a license key.
- **No license keys, no activation, no feature gating, no proprietary premium features, no trial limits.** The app does not check whether you paid. This keeps the product consistent with the GPL.
- Buyers keep **all GPL rights**: they may run the software for any purpose, study and modify it, and redistribute it (including their own builds) under the GPL. Nothing in the purchase terms may restrict this (see the GNU project's own explanation: https://www.gnu.org/philosophy/selling.html).
- No lifetime promises: the update and support terms below are time-limited and written down.

## 2. Offer (suggested)

| Item                                       | Suggested price                                           | What the buyer gets                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Official build** (standard)              | **US$15** one-time                                        | The official signed installer of the **current major version** (0.x / 1.x as defined at release), **12 months of updates** (new releases of that major version, security and bug fixes, delivered by download link and, once the owner has chosen and hosted an update feed, by in-app update), a download link and receipt, standard email support within the scope below |
| **Supporter** (optional)                   | **US$29** one-time                                        | The same software and the same 12 months of updates as the standard offer, plus supporter recognition (an optional name in a supporters list) and **priority** email support within the scope below. No extra features                                                                                                                                                     |
| **Future major upgrade** (optional, later) | owner decides, for example a discount for existing buyers | A new major version (for example 2.0) is a separate purchase, possibly with an upgrade discount. Not promised; decide when a major version exists                                                                                                                                                                                                                          |
| **Free**                                   | US$0                                                      | Source code, build instructions, community issue tracker, and the right to build and use the software yourself. Free builds may be unsigned and are not covered by the support terms                                                                                                                                                                                       |

### After the update term

- The installed version **keeps working forever**: there is no expiry, no license check and no phone-home.
- After 12 months the buyer simply stops receiving _official_ updates and support. They can renew (if the owner offers a renewal), buy a later major version, build from source themselves, or keep using the version they have.
- Update delivery for an expired buyer: the owner decides whether the latest official signed installer remains downloadable by anyone (recommended for trust and simplicity; the paid value is then support and the time-limited update promise). Since there is no license enforcement, any public download is available to everybody; this proposal does not try to prevent that.
- Security fixes after the term are at the owner's discretion; the buyer can always take them from the public source.

## 3. Support scope and response targets (proposal)

| Included                                                                                                               | Not included                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Installing and running the official build on a supported Windows version (Windows 10+, x64, once Windows 10 is tested) | Windows on ARM, macOS, Linux, other builds, or modified/forked builds          |
| Bugs in documented features; capture/recording/export problems reproducible with logs                                  | Custom development, integrations, training, help with third-party tools        |
| Questions about settings, shortcuts, recovery, MP4 export                                                              | Recovering data the app could not save (recovery is best effort, see the docs) |
| Security reports ([SECURITY.md](../SECURITY.md))                                                                       | Legal, tax, compliance or codec-licensing advice                               |

Suggested response targets (owner to confirm what is realistic for one person; do not publish targets you cannot meet): standard support first reply within 3 business days; priority support within 1 business day; no guaranteed resolution time; best effort, email only, English; support period equals the update term (12 months from purchase). Support address: `[OWNER: add support email]`.

## 4. Refund policy (owner decision)

Proposal: full refund on request within **14 days** of purchase, no reasons needed, handled by the payment provider's refund tool. The merchant of record's own terms (see [checkout-integration-requirements.md](checkout-integration-requirements.md)) may impose their own refund rules; the owner's policy must be compatible with them. Provide the policy text on the purchase page. `[OWNER: decide]`.

## 5. Delivery

Delivery needs no license key: a **download link** to the official installer (with its SHA-256 and the written GPL source offer), plus the provider's **receipt**. Supporters are asked (optionally) for the name to list. No customer account in the app. See [checkout-integration-requirements.md](checkout-integration-requirements.md).

## 6. Prerequisites before anything is sold

- Name and trademark clearance (Framelet is provisional); final app id and publisher string (changing them later breaks upgrades and taskbar pins).
- A code-signing certificate and a verified signed build (the paid offer's main promise is a signed installer; today's installer is unsigned and says so everywhere).
- FFmpeg corresponding source mirrored alongside each binary release, third-party notices shipped in the installer, and the codec/patent review for H.264/AAC (selling a product that includes encoders is where such licensing questions most often arise).
- An update feed and a privacy note if in-app updates are offered (the app currently never touches the network).
- Payment provider selected and approved for the owner's country of residence (nothing selected yet: see the checkout document).
- Terms of sale, privacy policy for the purchase page, refund policy, tax registration questions (a merchant of record usually handles sales tax/VAT collection; the owner still has income-tax duties in their own country) reviewed by a qualified person.
- Support mailbox and the written support scope above.

## 7. Risks and honest expectations

- **Anyone can rebuild and give away Framelet for free; the GPL allows it.** The product is therefore trust, convenience, a signed installer, updates and support, not exclusivity. Some users will always take the free route; that is intended and fine.
- Competing forks or resellers may appear. The owner cannot prevent redistribution; they can protect the name and logo through trademark (another reason to clear the name early).
- A signing certificate has recurring cost; fees per sale are a significant share of a US$15 price (see fees in the checkout document). Revenue may be small; do not plan on it to cover costs without measuring demand.
- Source-offer duty applies to the owner as a distributor of FFmpeg: it is ongoing work per release.
- Codec/patent questions could force removing H.264/AAC export or changing the FFmpeg build; unresolved.
- Support load is real work for a single maintainer; the scope and response targets above exist to bound it.
- Wording discipline: never describe the paid build as "licensed", "activated" or "the only legal copy", and never describe the unsigned build as signed.
