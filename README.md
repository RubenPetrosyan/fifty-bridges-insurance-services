# Fifty Bridges Insurance Services

Commercial truck insurance brokerage website built around the endowment effect: fleet owners and independent owner-operators feel like they already own a customized, high-value insurance package and safety system before they sign or pay.

## What's on the page

- **Hero + Fleet Portal widget** — "Your Fifty Bridges Fleet Vault is Ready." Enter a company name or US DOT # and instantly see "[Company]'s Customized Fleet Risk Profile & COI Center (Pre-Configured)."
- **The Pre-Built Fleet Vault** — Instant 24/7 COI Generator (Active), $1,000 Safety Audit Credit (Locked In), DOT Compliance & Loss-Control Tracker (Ready for Review).
- **Reverse Trial tools** — Telematics integrations, Safety Training Modules, Driver Onboarding Checklists, framed as assets lost if the visitor walks away.
- **Endowment-driven comparison** — Standard Brokers vs. Your Fifty Bridges Account, compared on operational assets, not generic features.
- **Claim form** — "Review & Lock In Your Tailored Coverage" with pre-checked package items (uncheck only to give them up) and ownership CTAs: "Claim Your Fifty Bridges Fleet Package" / "Unlock Your Pre-Configured COI Portal."
- **Real COI PDF** — "Download Your Sample COI (PDF)" generates a real, downloadable PDF in the browser (no server, no external library). It is clearly marked SAMPLE — NOT A LIVE CERTIFICATE, contains no policy number or insurer, and is not a binding certificate. A live COI is issued only after coverage is locked in.
- **Claim submissions by email** — The claim form posts to FormSubmit (AJAX) and is emailed to rubenpetrosyan89@gmail.com. Note: the first submission triggers a one-time FormSubmit activation email to that inbox, which must be clicked before later submissions are delivered. The form also has a plain POST fallback (same endpoint) if JavaScript is off. The destination email is visible in the page source — a tradeoff of a static form.

## Tone & language rules

- Professional, authoritative, partner-focused, protective.
- Say: "Your customized commercial motor carrier coverage is built." Not: "We offer truck insurance."
- Say: "Claim your prepared risk mitigation plan." Not: "Request a proposal."

## Run / deploy

Static site, no build step. Serve `index.html` directly, or deploy as a Vercel project with Framework Preset: Other, no build command.

Address on file: 4695 MacArthur Court, Newport Beach, CA 92660.
